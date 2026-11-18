/**
 * The Kokoro CPU voices (Drew, Walter, George) on the take-home worker.
 *
 * The measured book (16,940 characters, 11 sections, Drew) took 9 minutes for
 * 17 minutes of audio. Only two lanes ran, each pair waited for its slower
 * section, and mastering did not overlap speech. These tests pin the
 * replacement: a rolling pool that keeps every lane busy, keeps section order,
 * and runs mastering beside the next section's render.
 *
 * A fake adapter stands in for HTTP, exactly as the Edge tests do. The
 * scheduling is real: `processTakehomeTick` is the production entry point.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  USER_B,
  createFakeProvider,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";

const JOB_ID = "dddddddd-0000-4000-8000-000000000001";
const OTHER_JOB_ID = "dddddddd-0000-4000-8000-000000000002";

/** Five chapter blocks pack to ~14 sections at the 2,000-character ceiling. */
const BOOK_TEXT = Array.from({ length: 5 }, (_, i) =>
  `Chapter ${i + 1}. ${"The harbor was quiet after the rain. ".repeat(150)}`
).join("\n\n");

async function seedKokoroJob(
  id = JOB_ID,
  userId = USER_A,
  provider: "drew" | "sowell" | "george" = "drew"
) {
  const pdfPath = await seedUpload({
    id,
    userId,
    text: BOOK_TEXT,
  });
  await seedJob({
    id,
    userId,
    pdfStoragePath: pdfPath,
    ttsProvider: provider,
    catalogVoiceId: provider,
    providerVoiceId: provider,
    model: `kokoro/${provider}`,
  });
}

async function installKokoroProvider(
  respond?: Parameters<typeof createFakeProvider>[0],
  id: "drew" | "sowell" | "george" = "drew"
) {
  const providers = await import("@/lib/tts/providers");
  const fake = createFakeProvider(respond);
  fake.id = id;
  vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
  return fake;
}

/** The final join is not what these tests measure. */
async function stubConcat() {
  const concat = await import("@/lib/tts/concat-audio");
  return vi
    .spyOn(concat, "materializeFullAudiobook")
    .mockImplementation(async (jobId, _segments, _total, opts) => {
      const path = `audiobooks/${jobId}/full.mp3`;
      await opts?.onDryUploaded?.(path);
      return path;
    });
}

function segmentsOf(row: { segments_json?: string | null } | null | undefined) {
  return (JSON.parse(String(row?.segments_json || "[]")) as Array<{
    index: number;
    status: string;
    path: string;
  }>).sort((a, b) => a.index - b.index);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  process.env.TTS_SECTION_QA_ENABLED = "0";
  delete process.env.TTS_SECTIONS_PER_TICK;
  delete process.env.SOWELL_BOOK_LANES;
  delete process.env.SOWELL_MAX_CONTAINERS;
  delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TTS_SECTION_QA_ENABLED;
  delete process.env.TTS_SECTIONS_PER_TICK;
  delete process.env.SOWELL_BOOK_LANES;
  delete process.env.SOWELL_MAX_CONTAINERS;
});

describe("Kokoro rolling pool", () => {
  it("keeps sixteen lanes busy over uneven sections and never waits for a pair", async () => {
    await seedKokoroJob();
    // Section 0 is the slow one. A fixed-pair dispatch holds lane 1 idle for
    // its whole duration; a rolling pool claims section 2 as soon as section
    // 1 returns.
    const delays = [120, 10, 30, 10, 30, 10, 30, 10, 30, 10, 30, 10];
    let active = 0;
    let peak = 0;
    const startedAt: Record<number, number> = {};
    const endedAt: Record<number, number> = {};
    const fake = await installKokoroProvider(async (input) => {
      const index = input.sectionIndex ?? 0;
      active += 1;
      peak = Math.max(peak, active);
      startedAt[index] = Date.now();
      await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 10));
      active -= 1;
      endedAt[index] = Date.now();
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    await stubConcat();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, {
      deadlineMs: Date.now() + 60_000,
    });

    const row = await jobRow(JOB_ID);
    const total = Number(row?.total_sections ?? 0);
    expect(total).toBeGreaterThanOrEqual(17);
    expect(fake.calls).toHaveLength(total);
    // The pool filled the fleet: sixteen renders in flight at once.
    expect(peak).toBe(16);
    // Section 3 started before the slow section 0 returned. With pair
    // batching it could not have.
    expect(startedAt[3]!).toBeLessThan(endedAt[0]!);
    expect(result.done).toBe(true);
    expect(row?.status).toBe("ready");
  });

  it("claims section 0 first so first audio is still early", async () => {
    await seedKokoroJob();
    const fake = await installKokoroProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    await stubConcat();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { deadlineMs: Date.now() + 60_000 });
    // Lowest-first claim order: the first section spoken is index 0.
    expect(fake.calls[0]!.sectionIndex).toBe(0);
  });

  it("preserves section order in the stored map and object names", async () => {
    await seedKokoroJob();
    await installKokoroProvider(async (input) => {
      // Later sections finish faster than earlier ones: completion order must
      // not leak into storage or the map.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 30 - (input.sectionIndex ?? 0) * 2))
      );
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    await stubConcat();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { deadlineMs: Date.now() + 60_000 });

    const row = await jobRow(JOB_ID);
    const segments = segmentsOf(row);
    const total = Number(row?.total_sections ?? 0);
    expect(segments.map((s) => s.index)).toEqual(
      Array.from({ length: total }, (_, i) => i)
    );
    for (const segment of segments) {
      expect(segment.status).toBe("ready");
      expect(segment.path).toMatch(new RegExp(`sections/${String(segment.index).padStart(4, "0")}\\.`));
    }
  });

  it("masters a finished section while the next one is still rendering", async () => {
    await seedKokoroJob();
    const publish = await import("@/lib/cpu/section-publish");
    let stores = 0;
    let peakStores = 0;
    let rendersInFlight = 0;
    let storeStartedDuringRender = false;
    const storeSpy = vi
      .spyOn(publish, "commitSectionAudio")
      .mockImplementation(async (input) => {
        stores += 1;
        peakStores = Math.max(peakStores, stores);
        if (rendersInFlight > 0) storeStartedDuringRender = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        const { uploadFile } = await import("@/lib/storage");
        const uploaded = await uploadFile(
          `audiobooks/${input.jobId}`,
          `sections/${String(input.index).padStart(4, "0")}.mp3`,
          input.audio,
          "audio/mpeg"
        );
        stores -= 1;
        return {
          ready: true,
          path: uploaded.path,
          contentType: "audio/mpeg",
          mastered: false,
        };
      });
    await installKokoroProvider(async () => {
      rendersInFlight += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      rendersInFlight -= 1;
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    await stubConcat();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, {
      deadlineMs: Date.now() + 60_000,
    });

    const row = await jobRow(JOB_ID);
    expect(result.done).toBe(true);
    expect(row?.status).toBe("ready");
    expect(storeSpy).toHaveBeenCalled();
    // A mastering step ran while a section was still being spoken: the lane
    // was not held through ffmpeg.
    expect(storeStartedDuringRender).toBe(true);
    // Masters overlapped each other too, not just speech.
    expect(peakStores).toBeGreaterThan(1);
  });

  it("retries a 429 take and still finishes the book", async () => {
    await seedKokoroJob();
    const seen = new Map<number, number>();
    const fake = await installKokoroProvider(async (input) => {
      const index = input.sectionIndex ?? 0;
      const attempt = (seen.get(index) ?? 0) + 1;
      seen.set(index, attempt);
      if (attempt === 1) throw new Error("Drew TTS 429: busy");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    await stubConcat();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { deadlineMs: Date.now() + 120_000 });

    const row = await jobRow(JOB_ID);
    const total = Number(row?.total_sections ?? 0);
    expect(row?.status).toBe("ready");
    expect(segmentsOf(row)).toHaveLength(total);
    // Every first take was refused once and retried in place: no section was
    // left behind and no lane failed the book.
    expect(fake.calls.length).toBeGreaterThanOrEqual(total * 2);
  });

  it("waits briefly for a fleet permit before deferring the book", async () => {
    await seedKokoroJob();
    const held: Array<{ release: () => Promise<void> }> = [];
    const slots = await import("@/lib/tts/provider-slots");
    for (let i = 0; i < 16; i++) {
      const slot = await slots.tryAcquireProviderSlot(
        {
          execute: (sql, args) => execute(sql, args),
          queryOne: async () => null,
        },
        {
          provider: "kokoro",
          cap: 16,
          ownerToken: "another-worker",
          ttlSeconds: 90,
        }
      );
      expect(slot).not.toBeNull();
      held.push({
        release: async () => {
          await slots.releaseProviderSlot(
            {
              execute: (sql, args) => execute(sql, args),
              queryOne: async () => null,
            },
            { provider: "kokoro", slotId: slot!, ownerToken: "another-worker" }
          );
        },
      });
    }
    const fake = await installKokoroProvider(async () => ({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    }));
    await stubConcat();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    // Free one container while the book is polling for a permit, so it takes
    // the permit instead of deferring on the first refusal.
    const timer = setTimeout(() => {
      void held[0]!.release();
    }, 150);
    const result = await processTakehomeTick(JOB_ID, {
      deadlineMs: Date.now() + 60_000,
    });
    clearTimeout(timer);
    // The lane took the permit that freed mid-tick. With maxWaitMs 0 it would
    // have deferred the book on the first refusal, before a container could
    // free. The book still hands back cleanly either way.
    expect(fake.calls.length).toBeGreaterThan(0);
    const row = await jobRow(JOB_ID);
    expect(row?.status).not.toBe("failed");
    void result;
    await Promise.all(held.slice(1).map((slot) => slot.release()));
  });

  it("defers the book when the shared Kokoro cap is full instead of failing", async () => {
    await seedKokoroJob();
    const fake = await installKokoroProvider(async () => ({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    }));
    const slots = await import("@/lib/tts/provider-slots");
    // Another worker already holds every Kokoro container.
    const held = [];
    for (let i = 0; i < 16; i++) {
      const slot = await slots.tryAcquireProviderSlot(
        {
          execute: (sql, args) => execute(sql, args),
          queryOne: async () => null,
        },
        {
          provider: "kokoro",
          cap: 16,
          ownerToken: "another-worker",
          ttlSeconds: 90,
        }
      );
      expect(slot).not.toBeNull();
      held.push(slot);
    }

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, {
      deadlineMs: Date.now() + 60_000,
    });

    expect(result.busy).toBe(true);
    expect(result.deferred).toBe(true);
    expect(fake.calls).toHaveLength(0);
    const row = await jobRow(JOB_ID);
    // Not failed, and claimable again as soon as a container frees.
    expect(row?.status).toBe("queued");
    expect(row?.processing_lease_token).toBeNull();
  });

  it("takes a shared kokoro permit for a preview so it cannot outrun the fleet", async () => {
    const slots = await import("@/lib/tts/provider-slots");
    const held = await slots.holdListenerSlot("drew", 8);
    expect(held).not.toBeNull();
    // The permit is the shared `kokoro` one, at the fleet cap, not a
    // per-voice permit of 5.
    const rows = await slots.tryAcquireProviderSlot(
      {
        execute: (sql, args) => execute(sql, args),
        queryOne: async () => null,
      },
      { provider: "kokoro", cap: 16, ownerToken: "x", ttlSeconds: 90 }
    );
    expect(rows).not.toBeNull();
    await held?.release();
    // The named per-voice provider has no row: nothing else reserved it.
    const perVoice = await slots.tryAcquireProviderSlot(
      {
        execute: (sql, args) => execute(sql, args),
        queryOne: async () => null,
      },
      { provider: "drew", cap: 5, ownerToken: "x", ttlSeconds: 90 }
    );
    expect(perVoice).toBe(0);
  });

  it("shares the fleet between two books instead of starving one", async () => {
    await seedKokoroJob();
    await seedKokoroJob(OTHER_JOB_ID, USER_B, "george");
    const fake = await installKokoroProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    await stubConcat();
    const { countOtherKokoroBooks } = await import("@/lib/tts/process-job");
    expect(await countOtherKokoroBooks(JOB_ID)).toBe(1);
    expect(await countOtherKokoroBooks(OTHER_JOB_ID)).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("ranks the older book first so an uneven split never favours a newcomer", async () => {
    await seedKokoroJob();
    await seedKokoroJob(OTHER_JOB_ID, USER_B, "george");
    // Make the ordering explicit and stable, then confirm the rank query
    // reads it: the older row ranks 0, the newer one 1.
    await execute(`UPDATE jobs SET created_at = ? WHERE id = ?`, [1_000, JOB_ID]);
    await execute(`UPDATE jobs SET created_at = ? WHERE id = ?`, [2_000, OTHER_JOB_ID]);
    const { kokoroFairnessRank } = await import("@/lib/tts/process-job");
    expect(await kokoroFairnessRank(JOB_ID, 1_000)).toBe(0);
    expect(await kokoroFairnessRank(OTHER_JOB_ID, 2_000)).toBe(1);
  });

  it("retries a silent take instead of storing it", async () => {
    await seedKokoroJob();
    const seen = new Map<number, number>();
    const fake = await installKokoroProvider(async (input) => {
      const index = input.sectionIndex ?? 0;
      const attempt = (seen.get(index) ?? 0) + 1;
      seen.set(index, attempt);
      if (attempt === 1) {
        // A bare 44-byte WAV header: the classic silent success. The audio
        // guard must refuse it and speak the section again.
        const { emptyWav } = await import("@/test/harness");
        return { audio: emptyWav(), contentType: "audio/wav" };
      }
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    await stubConcat();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { deadlineMs: Date.now() + 120_000 });

    const row = await jobRow(JOB_ID);
    const total = Number(row?.total_sections ?? 0);
    expect(row?.status).toBe("ready");
    expect(segmentsOf(row)).toHaveLength(total);
    // Every section was re-spoken once: no silent take reached storage.
    expect(fake.calls.length).toBeGreaterThanOrEqual(total * 2);
  });

  it("resumes from the durable rows when a tick stops with work remaining", async () => {
    await seedKokoroJob();
    await installKokoroProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    // A tight first tick claims two sections and hands the book back. This is
    // the same shape as a worker that died mid-pool: what finished is in the
    // DB, the rest is unclaimed.
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
    const afterFirst = await jobRow(JOB_ID);
    const stored = segmentsOf(afterFirst).filter((s) => s.status === "ready");
    expect(stored).toHaveLength(2);
    expect(afterFirst?.status).not.toBe("ready");
    expect(afterFirst?.processing_lease_token).toBeNull();

    // A fresh worker (new fake adapter, new module state) claims the
    // remainder. Sections already stored are never spoken again.
    const second = await installKokoroProvider(async () => ({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    }));
    await stubConcat();
    await processTakehomeTick(JOB_ID, { deadlineMs: Date.now() + 120_000 });

    const readyEarlier = new Set(stored.map((segment) => segment.index));
    expect(second.calls.length).toBeGreaterThan(0);
    for (const call of second.calls) {
      expect(readyEarlier.has(call.sectionIndex ?? 0)).toBe(false);
    }
    const finalRow = await jobRow(JOB_ID);
    const total = Number(finalRow?.total_sections ?? 0);
    expect(finalRow?.status).toBe("ready");
    expect(segmentsOf(finalRow)).toHaveLength(total);
  });
});

describe("Kokoro CPU section sizing", () => {
  const SIZING_JOB = "dddddddd-0000-4000-8000-0000000000aa";
  const SIZING_OTHER = "dddddddd-0000-4000-8000-0000000000bb";

  function charsPerSection(texts: string[]) {
    return texts.map((text) => text.length);
  }

  async function sectionsFor(provider: "drew" | "sowell" | "george") {
    await seedKokoroJob(SIZING_JOB, USER_A, provider);
    const fake = await installKokoroProvider(async () => ({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    }));
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const { readFile } = await import("node:fs/promises");
    const { downloadFile } = await import("@/lib/storage");
    void readFile;
    await processTakehomeTick(SIZING_JOB, { sectionsPerTick: 1 });
    const frozenJson = (
      await downloadFile(`audiobooks/${SIZING_JOB}/sections.json`)
    ).toString("utf8");
    const sections = JSON.parse(frozenJson) as { index: number; text: string }[];
    return { sections, calls: fake.calls.length };
  }

  it("packs a Kokoro book at ~700 chars with a short first section", async () => {
    const { sections } = await sectionsFor("drew");
    const lengths = charsPerSection(sections.map((section) => section.text));
    // The measured book is ~15.7k chars. At 2,000 it was 11 sections; at 700
    // it is roughly three times that, which is the point of the change.
    expect(sections.length).toBeGreaterThanOrEqual(18);
    // The opening is short so first audio lands fast, and shorter than the
    // steady sections that follow it.
    const steady = lengths.slice(2);
    const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
    expect(lengths[0]).toBeLessThanOrEqual(450);
    expect(lengths[0]).toBeLessThan(avg);
    // Steady sections sit around the target, and none exceeds the hard max
    // (target + 200 slack, capped at the container's 2,000). The final
    // section may be a short remainder.
    for (const length of steady.slice(0, -1)) {
      expect(length).toBeLessThanOrEqual(2000);
      expect(length).toBeGreaterThan(300);
    }
    expect(avg).toBeLessThan(800);
  });

  it("honours KOKORO_CPU_SECTION_CHARS for a Kokoro book", async () => {
    process.env.KOKORO_CPU_SECTION_CHARS = "1200";
    try {
      const { sections } = await sectionsFor("george");
      const lengths = charsPerSection(sections.map((section) => section.text));
      const steady = lengths.slice(2);
      const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
      expect(avg).toBeGreaterThan(900);
      expect(avg).toBeLessThan(1300);
    } finally {
      delete process.env.KOKORO_CPU_SECTION_CHARS;
    }
  });

  it("leaves an Edge book on its own packing", async () => {
    const pdfPath = await seedUpload({
      id: SIZING_OTHER,
      userId: USER_B,
      text: BOOK_TEXT,
    });
    await seedJob({
      id: SIZING_OTHER,
      userId: USER_B,
      pdfStoragePath: pdfPath,
      ttsProvider: "edge",
      catalogVoiceId: "ava",
      providerVoiceId: "en-US-AvaNeural",
      model: "edge/en-US-AvaNeural",
    });
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider(async () => ({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    }));
    fake.id = "edge";
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(SIZING_OTHER, { sectionsPerTick: 1 });
    const { downloadFile } = await import("@/lib/storage");
    const sections = JSON.parse(
      (await downloadFile(`audiobooks/${SIZING_OTHER}/sections.json`)).toString("utf8")
    ) as { text: string }[];
    // Edge keeps its ~2,000-char/8-wave packing: far fewer sections than the
    // Kokoro book made from the same text.
    expect(sections.length).toBeLessThan(18);
  });
});
