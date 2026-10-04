/**
 * Worker lease behaviour.
 *
 * The failure this guards against is silent and expensive: two invocations
 * synthesizing the same section, double-billing OpenRouter and racing on
 * `segments_json`. The previous implementation reclaimed any job that had been
 * `processing` for 75 seconds, which cannot distinguish a hung worker from a
 * slow one — so every section slower than the timeout was generated twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  createFakeProvider,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute, query } from "@/lib/turso";

const JOB_ID = "cccccccc-0000-4000-8000-000000000001";

async function seedTakehomeJob(text = "A sentence. ".repeat(300)) {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text,
  });
  await seedJob({ id: JOB_ID, userId: USER_A, pdfStoragePath: pdfPath });
}

async function useProvider(
  respond?: Parameters<typeof createFakeProvider>[0]
) {
  const providers = await import("@/lib/tts/providers");
  const fake = createFakeProvider(respond);
  vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
  return fake;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  process.env.TTS_SECTIONS_PER_TICK = "2";
  delete process.env.TTS_TAKEHOME_FANOUT;
  delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
});

describe("claimTakehomeLease", () => {
  it("grants the lease to exactly one of two racing workers", async () => {
    await seedTakehomeJob();
    const { claimTakehomeLease } = await import("@/lib/tts/process-job");

    const first = await claimTakehomeLease(JOB_ID);
    const second = await claimTakehomeLease(JOB_ID);

    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect((await jobRow(JOB_ID))?.processing_lease_token).toBe(first);
  });

  it("refuses to reclaim a lease that is still alive, however long the section takes", async () => {
    await seedTakehomeJob();
    const { claimTakehomeLease } = await import("@/lib/tts/process-job");

    const held = await claimTakehomeLease(JOB_ID, 90);
    expect(held).toBeTruthy();

    // Simulate a worker that has been synthesizing one slow section for ten
    // minutes but is still heartbeating: the lease has not expired.
    await execute(
      `UPDATE jobs SET processing_started_at = unixepoch() - 600,
        lease_expires_at = unixepoch() + 60 WHERE id = ?`,
      [JOB_ID]
    );

    expect(await claimTakehomeLease(JOB_ID)).toBeNull();
  });

  it("reclaims a lease that expired because the worker died", async () => {
    await seedTakehomeJob();
    const { claimTakehomeLease } = await import("@/lib/tts/process-job");

    const abandoned = await claimTakehomeLease(JOB_ID, 90);
    await execute(
      `UPDATE jobs SET lease_expires_at = unixepoch() - 1 WHERE id = ?`,
      [JOB_ID]
    );

    const reclaimed = await claimTakehomeLease(JOB_ID);
    expect(reclaimed).toBeTruthy();
    expect(reclaimed).not.toBe(abandoned);
  });
});

describe("processTakehomeTick", () => {
  it("reports busy without synthesizing when another worker holds the lease", async () => {
    await seedTakehomeJob();
    const fake = await useProvider();
    const { claimTakehomeLease, processTakehomeTick } = await import(
      "@/lib/tts/process-job"
    );

    await claimTakehomeLease(JOB_ID, 90);
    const result = await processTakehomeTick(JOB_ID);

    expect(result.busy).toBe(true);
    expect(result.done).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("defers without synthesizing while the upload is still extracting", async () => {
    await seedTakehomeJob();
    await execute(
      `UPDATE uploads SET status = 'extracting', char_count = 0 WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const fake = await useProvider();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    const result = await processTakehomeTick(JOB_ID);

    expect(result.done).toBe(false);
    expect(result.busy).toBe(true);
    expect(result.deferred).toBe(true);
    expect(fake.calls).toHaveLength(0);
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("waiting");
    expect(row?.processing_lease_token).toBeNull();

    // The upload lands; the next tick synthesizes instead of deferring.
    await execute(
      `UPDATE uploads SET status = 'ready', char_count = 4800 WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const next = await processTakehomeTick(JOB_ID);
    expect((next as { deferred?: boolean }).deferred ?? false).toBe(false);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("returns a deferred wave on the first tick instead of spinning", async () => {
    await seedTakehomeJob();
    await execute(
      `UPDATE uploads SET status = 'extracting', char_count = 0 WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const fake = await useProvider();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    const { runTakehomeWave } = await import("@/lib/tts/process-job");

    const wave = await runTakehomeWave(JOB_ID, 60_000);

    expect(wave).toEqual({ deferred: true });
    expect(fake.calls).toHaveLength(0);
    expect(logs.filter((line) => line.includes("waiting for extract"))).toHaveLength(1);
    expect(logs.some((line) => line.includes("tick "))).toBe(false);
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("waiting");
    expect(row?.processing_lease_token).toBeNull();
  });

  it("is not matched by the legacy Trigger drain claim while parked", async () => {
    await seedTakehomeJob();
    await execute(
      `UPDATE uploads SET status = 'extracting', char_count = 0 WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const queuedPath = await seedUpload({
      id: "22222222-2222-4222-8222-222222222222",
      userId: USER_A,
      text: "Ready book. ".repeat(40),
    });
    await seedJob({
      id: "cccccccc-0000-4000-8000-000000000099",
      userId: USER_A,
      pdfStoragePath: queuedPath,
      status: "queued",
    });
    const { processTakehomeTick, listDrainableTakehomeJobs } = await import(
      "@/lib/tts/process-job"
    );
    await processTakehomeTick(JOB_ID);
    expect((await jobRow(JOB_ID))?.status).toBe("waiting");

    // Frozen from the deployed takehome.drain (list + claim before `waiting`).
    const legacyList = await query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE deleted_at IS NULL
         AND job_kind = 'takehome'
         AND (
           status = 'queued'
           OR (
             status = 'processing'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= unixepoch()
           )
         )`
    );
    expect(legacyList.map((row) => row.id)).not.toContain(JOB_ID);
    expect(legacyList.map((row) => row.id)).toContain(
      "cccccccc-0000-4000-8000-000000000099"
    );

    const legacyClaim = await execute(
      `UPDATE jobs SET status = 'processing',
         processing_lease_token = ?,
         lease_expires_at = unixepoch() + ?,
         processing_started_at = unixepoch(),
         generation_started_at = COALESCE(generation_started_at, unixepoch()),
         updated_at = unixepoch()
       WHERE id = ? AND deleted_at IS NULL
         AND status IN ('queued', 'processing')
         AND (processing_lease_token IS NULL
              OR lease_expires_at IS NULL
              OR lease_expires_at <= unixepoch())`,
      ["legacy-token", 90, JOB_ID]
    );
    expect(legacyClaim.rowsAffected).toBe(0);
    expect((await jobRow(JOB_ID))?.status).toBe("waiting");
    expect(await listDrainableTakehomeJobs()).toContain(JOB_ID);
  });

  it("fails the job with the upload's message when the upload failed", async () => {
    await seedTakehomeJob();
    await execute(
      `UPDATE uploads SET status = 'failed',
        error_message = 'This file took too long to read. Try again.' WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const fake = await useProvider();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    await processTakehomeTick(JOB_ID);

    expect(fake.calls).toHaveLength(0);
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("failed");
    expect(String(row?.error_message)).toBe(
      "This file took too long to read. Try again."
    );
    expect(row?.processing_lease_token).toBeNull();
  });

  it("abandons its work instead of clobbering a successor that took the lease", async () => {
    await seedTakehomeJob();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    // The first synthesis succeeds, but before the progress write lands another
    // worker has taken over. The losing worker must not overwrite its state.
    await useProvider(async () => {
      await execute(
        `UPDATE jobs SET processing_lease_token = 'usurper',
         lease_expires_at = unixepoch() + 90 WHERE id = ?`,
        [JOB_ID]
      );
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });

    const result = await processTakehomeTick(JOB_ID);

    expect(result.busy).toBe(true);
    const row = await jobRow(JOB_ID);
    expect(row?.processing_lease_token).toBe("usurper");
    // Claim cursor may have moved; the losing worker must not store audio.
    expect(row?.segments_json).toBeFalsy();
  });

  it("skips sections that are already stored", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: Array.from({ length: 400 }, (_, i) => `Sentence number ${i}. `).join(
        ""
      ),
    });
    await seedJob({ id: JOB_ID, userId: USER_A, pdfStoragePath: pdfPath });

    const fake = await useProvider();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    const first = await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    expect(fake.calls).toHaveLength(1);

    // Rewind the cursor as a crashed worker would have left it; the stored
    // section must be reused rather than paid for twice.
    await execute(`UPDATE jobs SET next_section_index = 0 WHERE id = ?`, [
      JOB_ID,
    ]);
    const second = await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    // Skip stored index 0; resume the lowest unready index (do not rebill 0).
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.text).not.toBe(fake.calls[1]!.text);
    expect(second.nextIndex).toBeGreaterThan(first.nextIndex);
  });

  it("first tick claims the full fan-out starting at 0, not only [0,1]", async () => {
    // Five chapter-sized blocks so ≥3 sections remain after packing.
    const text = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"]
      .map((word) => `${word}. `.repeat(600))
      .join("\n\n");
    await seedTakehomeJob(text);
    process.env.TTS_TAKEHOME_FANOUT = "3";
    process.env.TTS_SECTIONS_PER_TICK = "3";

    const fake = await useProvider();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 3 });

    const row = await jobRow(JOB_ID);
    expect(Number(row?.total_sections)).toBeGreaterThanOrEqual(5);
    expect(fake.calls).toHaveLength(3);
    const segments = JSON.parse(String(row?.segments_json || "[]")) as Array<{
      index: number;
    }>;
    expect(
      [...segments].sort((a, b) => a.index - b.index).map((s) => s.index)
    ).toEqual([0, 1, 2]);
    expect(Number(row?.next_section_index)).toBe(3);
  });

  it("returns the job to the queue when a tick throws", async () => {
    await seedTakehomeJob();
    await useProvider(() => {
      throw new Error("network unreachable");
    });
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    await processTakehomeTick(JOB_ID);
    const row = await jobRow(JOB_ID);

    // Three attempts exhausted → the job fails with a message, and no lease is
    // left behind to block a retry.
    expect(row?.status).toBe("failed");
    expect(String(row?.error_message)).toContain("network unreachable");
    expect(row?.processing_lease_token).toBeNull();
  });

  it("reuses frozen sections.json and does not re-split on later ticks", async () => {
    const original = [
      "Chapter 1",
      "The opening chapter stays frozen even if the cleaner later changes. ".repeat(40),
      "Chapter 2",
      "The second chapter is also frozen at first claim. ".repeat(40),
    ].join("\n\n");
    await seedTakehomeJob(original);
    const fake = await useProvider();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const { frozenSectionsPath } = await import("@/lib/tts/frozen-script");
    const { downloadFile, uploadFile } = await import("@/lib/storage");

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    const frozenRaw = (await downloadFile(frozenSectionsPath(JOB_ID))).toString(
      "utf8"
    );
    const frozen = JSON.parse(frozenRaw) as Array<{ index: number; text: string }>;
    expect(frozen.length).toBeGreaterThan(1);
    const firstText = frozen[0]!.text;

    const pdfPath = String((await jobRow(JOB_ID))?.pdf_storage_path);
    await uploadFile(
      pdfPath.replace(/\/content\.txt$/, ""),
      "content.txt",
      Buffer.from(
        "THIS WOULD SPLIT DIFFERENTLY AFTER A CLEANER CHANGE. ".repeat(200),
        "utf8"
      ),
      "text/plain"
    );

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    expect(firstText).toContain("opening chapter stays frozen");
    expect(fake.calls[0]!.text).toContain("opening chapter stays frozen");
    expect(fake.calls[1]!.text).not.toContain("THIS WOULD SPLIT DIFFERENTLY");
    expect(fake.calls[1]!.text).toBe(frozen[1]!.text);
    expect(frozen.some((section) => section.text.includes("second chapter is also frozen"))).toBe(
      true
    );
  });

  it("does not fail the job when one section fails and others succeed", async () => {
    const text = [
      "Chapter 1",
      "Successful opening narration occupies this first window. ".repeat(30),
      "Chapter 2",
      "This chapter is forced to fail at the provider. ".repeat(30),
      "Chapter 3",
      "A later chapter can still succeed after the hole. ".repeat(30),
    ].join("\n\n");
    await seedTakehomeJob(text);
    let calls = 0;
    await useProvider(async (input) => {
      calls += 1;
      if (input.text.includes("forced to fail")) {
        throw new Error("provider 500");
      }
      return { audio: fakeMp3(), contentType: "audio/mpeg" };
    });
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 5 });
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 5 });
    const row = await jobRow(JOB_ID);
    expect(row?.status).not.toBe("failed");
    const segments = JSON.parse(String(row?.segments_json || "[]")) as Array<{
      index: number;
      status: string;
      path?: string;
    }>;
    expect(segments.some((s) => s.status === "ready")).toBe(true);
    expect(
      segments.some((s) => s.status === "failed" || s.status === "retry")
    ).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("claims six Edge sections and does not take a Fish slot", async () => {
    const text = Array.from(
      { length: 8 },
      (_, i) =>
        `Chapter ${i + 1}. ${"The harbor was quiet after the rain. ".repeat(80)}`
    ).join("\n\n");
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text,
    });
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "edge",
      providerVoiceId: "en-US-AndrewNeural",
      catalogVoiceId: "standard",
      model: "edge/en-US-AndrewNeural",
    });
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "6";
    process.env.TTS_TAKEHOME_FANOUT = "4";
    process.env.TTS_SECTIONS_PER_TICK = "8";
    const slots = await import("@/lib/tts/fish-slots");
    const slotSpy = vi.spyOn(slots, "withFishSlot");
    const fake = await useProvider();
    fake.id = "edge";
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 8 });

    expect(fake.calls).toHaveLength(6);
    expect(slotSpy).not.toHaveBeenCalled();
  });

  it("keeps a Fish job on the Fish fan-out when Edge concurrency is higher", async () => {
    const text = Array.from(
      { length: 8 },
      (_, i) =>
        `Chapter ${i + 1}. ${"The harbor was quiet after the rain. ".repeat(120)}`
    ).join("\n\n");
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text,
    });
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-free",
    });
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "8";
    process.env.TTS_TAKEHOME_FANOUT = "4";
    process.env.TTS_SECTIONS_PER_TICK = "8";
    const slots = await import("@/lib/tts/fish-slots");
    const slotSpy = vi.spyOn(slots, "withFishSlot");
    const fake = await useProvider();
    fake.id = "fish";
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 8 });

    expect(fake.calls).toHaveLength(4);
    expect(slotSpy).toHaveBeenCalled();
  });
});

describe("releaseExpiredTakehomeLeases", () => {
  it("requeues a job whose worker vanished", async () => {
    await seedTakehomeJob();
    const { claimTakehomeLease, releaseExpiredTakehomeLeases } = await import(
      "@/lib/tts/process-job"
    );

    await claimTakehomeLease(JOB_ID, 90);
    await execute(
      `UPDATE jobs SET lease_expires_at = unixepoch() - 5 WHERE id = ?`,
      [JOB_ID]
    );

    expect(await releaseExpiredTakehomeLeases()).toBe(1);
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("queued");
    expect(row?.processing_lease_token).toBeNull();
  });

  it("leaves a live lease alone", async () => {
    await seedTakehomeJob();
    const { claimTakehomeLease, releaseExpiredTakehomeLeases } = await import(
      "@/lib/tts/process-job"
    );

    await claimTakehomeLease(JOB_ID, 90);
    expect(await releaseExpiredTakehomeLeases()).toBe(0);
    expect((await jobRow(JOB_ID))?.status).toBe("processing");
  });
});

describe("tickWriteHeadroomMs", () => {
  it("does not consume an entire short poll-nudge budget", async () => {
    const { tickWriteHeadroomMs } = await import("@/lib/tts/process-job");
    // Former bug: flat 8s headroom on an 8s nudge left zero time for section 0.
    expect(tickWriteHeadroomMs(8_000)).toBeLessThan(8_000);
    expect(tickWriteHeadroomMs(8_000)).toBeLessThanOrEqual(800);
    expect(tickWriteHeadroomMs(45_000)).toBe(2_000);
    expect(tickWriteHeadroomMs(240_000)).toBe(8_000);
  });
});

describe("Whole book Fish quality settings", () => {
  it("synthesizes section 0 at latency balanced and later sections at normal", async () => {
    await seedTakehomeJob(
      [
        "Abstract",
        "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. ".repeat(
          30
        ),
        "1 Introduction",
        "Recurrent neural networks have been firmly established as state of the art approaches in sequence modeling and machine translation. ".repeat(
          30
        ),
      ].join("\n\n")
    );
    const fake = await useProvider();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    expect(fake.calls[0]!.latency).toBe("balanced");
    expect(fake.calls[1]!.latency).toBe("normal");
    expect(fake.calls[0]!.chunkLength).toBe(300);
    expect(fake.calls[1]!.chunkLength).toBe(300);
    // Academic prose starts below 1.0 so section 0 is not rushed.
    expect(fake.calls[0]!.speed).toBeGreaterThanOrEqual(0.82);
    expect(fake.calls[0]!.speed).toBeLessThanOrEqual(0.88);
  });

  it("starts a clone's first section below 1.0", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Hello there. How are you today? Fine thanks.",
    });
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      catalogVoiceId: "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeeffff",
    });
    const fake = await useProvider();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    expect(fake.calls.length).toBeGreaterThanOrEqual(1);
    expect(fake.calls[0]!.speed).toBeGreaterThanOrEqual(0.82);
    expect(fake.calls[0]!.speed).toBeLessThan(1);
    expect(fake.calls[0]!.latency).toBe("balanced");
  });

  it("sends Fish plain text and keeps pause tags for Edge and Google", async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const chapter1 =
      "Chapter 1\n\nShe whispered UNIQUEONE softly near the quay. " +
      "The tide turned along the stones while evening settled in. ".repeat(60);
    const chapter2 =
      "Chapter 2\n\nHe sighed UNIQUETWO and looked away across the dark water. " +
      "Night held its breath over the river until dawn. ".repeat(60);
    const full = `${chapter1}\n\n${chapter2}`;
    const taggedBodies: string[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body || "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const user =
        parsed.messages?.find((m) => m.role === "user")?.content || "";
      taggedBodies.push(user);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `[sarcastic] ${user}` } }],
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchFn);

    try {
      const providers = await import("@/lib/tts/providers");
      const fake = createFakeProvider();
      vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);

      const { processTakehomeTick } = await import("@/lib/tts/process-job");

      const runTaggedJob = async (opts: {
        id: string;
        uploadId: string;
        provider: "fish" | "edge" | "google";
        catalogVoiceId: string;
        model: string;
      }) => {
        fetchFn.mockClear();
        taggedBodies.length = 0;
        fake.calls.length = 0;
        fake.id = opts.provider;
        const path = await seedUpload({
          id: opts.uploadId,
          userId: USER_A,
          text: full,
        });
        await seedJob({
          id: opts.id,
          userId: USER_A,
          pdfStoragePath: path,
          ttsProvider: opts.provider,
          catalogVoiceId: opts.catalogVoiceId,
          model: opts.model,
        });
        await processTakehomeTick(opts.id, { sectionsPerTick: 5 });
        expect(taggedBodies.length).toBeGreaterThanOrEqual(1);
        expect(taggedBodies.some((b) => b.includes("UNIQUEONE"))).toBe(true);
        expect(taggedBodies.some((b) => b.includes("UNIQUETWO"))).toBe(true);
        expect(fake.calls.length).toBeGreaterThanOrEqual(1);
        expect(fake.calls.some((c) => c.text.includes("UNIQUEONE"))).toBe(true);
        if (opts.provider === "fish") {
          expect(fake.calls.every((c) => !/\[[^\]]+\]/.test(c.text))).toBe(
            true
          );
        } else {
          expect(
            fake.calls.every(
              (c) => !/\[calm\]|\[sarcastic\]|\[whispering\]|\[sighing\]/.test(c.text)
            )
          ).toBe(true);
          expect(
            fake.calls.some((c) => /\[(?:long-)?break\]/.test(c.text))
          ).toBe(true);
        }
      };

      await runTaggedJob({
        id: JOB_ID,
        uploadId: UPLOAD_ID_A,
        provider: "fish",
        catalogVoiceId: "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeeffff",
        model: "s2.1-pro-free",
      });
      await runTaggedJob({
        id: "cccccccc-0000-4000-8000-000000000099",
        uploadId: "11111111-1111-4111-8111-111111111199",
        provider: "edge",
        catalogVoiceId: "standard",
        model: "edge-tts",
      });

      fake.calls.length = 0;
      const googleId = "cccccccc-0000-4000-8000-000000000098";
      const googlePath = await seedUpload({
        id: "11111111-1111-4111-8111-111111111198",
        userId: USER_A,
        text: full,
      });
      await seedJob({
        id: googleId,
        userId: USER_A,
        pdfStoragePath: googlePath,
        ttsProvider: "google",
        catalogVoiceId: "randolph",
        providerVoiceId: "en-GB-Neural2-O",
        model: "en-GB-Neural2-O",
      });
      await processTakehomeTick(googleId, { sectionsPerTick: 5 });
      expect(fake.calls).toHaveLength(0);
      const parked = await jobRow(googleId);
      expect(parked?.status).toBe("failed");
      expect(parked?.segments_json ?? null).toBeNull();
      expect(String(parked?.error_message || "")).toMatch(/unchanged/i);
    } finally {
      vi.unstubAllGlobals();
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("marks the job ready on dry concat before remaster finishes", async () => {
    await seedTakehomeJob("Hello world. ".repeat(40));
    await useProvider();
    const concat = await import("@/lib/tts/concat-audio");
    let statusDuringRemaster = "";
    vi.spyOn(concat, "materializeFullAudiobook").mockImplementation(
      async (jobId, _segments, _total, opts) => {
        const path = `audiobooks/${jobId}/full.mp3`;
        await opts?.onDryUploaded?.(path);
        statusDuringRemaster = String((await jobRow(jobId))?.status || "");
        await new Promise((r) => setTimeout(r, 20));
        return path;
      }
    );

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 5 });
    expect(result.done).toBe(true);
    expect(statusDuringRemaster).toBe("ready");
    expect((await jobRow(JOB_ID))?.status).toBe("ready");
  });

  it("stays ready when the lease is gone by the time the full file is uploaded", async () => {
    await seedTakehomeJob("Hello world. ".repeat(40));
    await useProvider();
    const concat = await import("@/lib/tts/concat-audio");
    vi.spyOn(concat, "materializeFullAudiobook").mockImplementation(
      async (jobId, _segments, _total, opts) => {
        const path = `audiobooks/${jobId}/full.mp3`;
        await execute(
          `UPDATE jobs SET processing_lease_token = 'stolen', lease_expires_at = unixepoch() + 300,
             status = 'processing' WHERE id = ?`,
          [jobId]
        );
        await opts?.onDryUploaded?.(path);
        return path;
      }
    );

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 5 });
    const row = await jobRow(JOB_ID);
    expect(result.done).toBe(true);
    expect(row?.status).toBe("ready");
    expect(row?.audio_storage_path).toBe(`audiobooks/${JOB_ID}/full.mp3`);
    expect(String(row?.error_message || "")).not.toMatch(/remux failed/);
  });

  it("does not mark a published book failed when assemble returns nothing", async () => {
    await seedTakehomeJob("Hello world. ".repeat(40));
    await useProvider();
    const concat = await import("@/lib/tts/concat-audio");
    vi.spyOn(concat, "materializeFullAudiobook").mockImplementation(async (jobId) => {
      await execute(
        `UPDATE jobs SET status = 'ready', audio_storage_path = ?, processing_lease_token = NULL,
           lease_expires_at = NULL WHERE id = ?`,
        [`audiobooks/${jobId}/full.mp3`, jobId]
      );
      return null;
    });

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 5 });
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("ready");
    expect(String(row?.error_message || "")).not.toMatch(/remux failed/);
  });
});

describe("poll nudge budget", () => {
  it("defaults to read-only; a mis-set env is hard-capped at 45s", async () => {
    const { DEFAULT_POLL_NUDGE_BUDGET_MS, MAX_POLL_NUDGE_BUDGET_MS } =
      await import("@/lib/tts/process-job");
    expect(DEFAULT_POLL_NUDGE_BUDGET_MS).toBe(0);
    expect(MAX_POLL_NUDGE_BUDGET_MS).toBe(45_000);
  });
});

describe("runTakehomeWave short nudge", () => {
  it("requeues instead of freezing when the tick cannot fit a model pass", async () => {
    await seedTakehomeJob("Hello world. ".repeat(40));
    const fake = await useProvider();
    const { runTakehomeWave } = await import("@/lib/tts/process-job");

    await runTakehomeWave(JOB_ID, 8_000);

    expect(fake.calls.length).toBe(0);
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("queued");
    expect(Number(row?.next_section_index ?? 0)).toBe(0);
  });
});

describe("parallel section order", () => {
  it("writes NNNN.mp3 by index even when later sections finish first", async () => {
    const text = "AAAA. ".repeat(80) + "\n\n" + "BBBB. ".repeat(80) + "\n\n"
      + "CCCC. ".repeat(80) + "\n\n" + "DDDD. ".repeat(80) + "\n\n"
      + "EEEE. ".repeat(80);
    await seedTakehomeJob(text);
    process.env.TTS_TAKEHOME_FANOUT = "5";
    process.env.TTS_SECTIONS_PER_TICK = "5";

    const delays = [40, 25, 8, 30, 5];
    let call = 0;
    await useProvider(async () => {
      const index = call;
      call += 1;
      await new Promise((r) => setTimeout(r, delays[index] ?? 10));
      return { audio: fakeMp3(2048, index + 1), contentType: "audio/mpeg" };
    });

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const { splitTextForTts } = await import("@/lib/tts/split-text");
    const { maxCharsForModel } = await import("@/lib/tts/section-size");
    const sections = splitTextForTts(text, maxCharsForModel({ provider: "openrouter" }));
    const result = await processTakehomeTick(JOB_ID, {
      sectionsPerTick: Math.min(5, sections.length),
    });

    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json || "[]")) as Array<{
      index: number;
      path: string;
    }>;
    const byIndex = [...segments].sort((a, b) => a.index - b.index);
    for (const seg of byIndex) {
      expect(seg.path).toMatch(
        new RegExp(`/sections/${String(seg.index).padStart(4, "0")}\\.`)
      );
    }
    expect(byIndex.map((s) => s.index)).toEqual(
      Array.from({ length: byIndex.length }, (_, i) => i)
    );
    if (result.done) {
      expect(String(row?.audio_storage_path)).toMatch(/\/(full\.|sections\.zip)/);
    }
  });
});

describe("drainTakehomeQueue", () => {
  it("ignores cancelled and failed jobs", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "A sentence. ".repeat(50),
    });
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "cancelled",
    });
    const fake = await useProvider();

    const { drainTakehomeQueue } = await import("@/lib/tts/process-job");
    const { picked } = await drainTakehomeQueue();

    expect(picked).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect((await jobRow(JOB_ID))?.status).toBe("cancelled");
  });
});

describe("section attempt budget", () => {
  it("does not abort a 9,000-character Fish section, and slot wait is not on the clock", async () => {
    const chars = 9_000;
    const sentence = "The harbor was quiet after the rain. ";
    let body = "";
    while (body.length < chars) body += sentence;
    body = body.slice(0, chars);

    const { sectionAttemptBudgetMs, processTakehomeTick } = await import(
      "@/lib/tts/process-job"
    );
    const budget = sectionAttemptBudgetMs("fish", chars);
    expect(budget).toBe(Math.ceil(chars / 10) * 1000 + 60_000);
    // Real Fish jobs run near 37 chars/s, so 9,000 characters need about 243s.
    // The previous cap was the Edge ceiling plus 20s, about 200s.
    expect(budget).toBeGreaterThanOrEqual(Math.ceil((chars / 37) * 1000));
    expect(budget).toBeGreaterThan(250_000);

    await seedTakehomeJob(body);
    await execute(
      `UPDATE jobs SET tts_provider = 'fish', provider_voice_id = 'clone-ref' WHERE id = ?`,
      [JOB_ID]
    );
    const { uploadFile } = await import("@/lib/storage");
    await uploadFile(
      `audiobooks/${JOB_ID}`,
      "sections.json",
      Buffer.from(
        JSON.stringify([
          {
            index: 0,
            text: body,
            chapterIndex: 0,
            chapterTitle: null,
            charStart: 0,
            charEnd: body.length,
          },
        ]),
        "utf8"
      ),
      "application/json"
    );

    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    const slots = await import("@/lib/tts/fish-slots");
    const slotSpy = vi.spyOn(slots, "withFishSlot").mockImplementation(async (fn) => {
      await new Promise((r) => setTimeout(r, 200));
      expect(timeouts).toHaveLength(0);
      return fn();
    });
    const fake = await useProvider(async () => ({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    }));
    fake.id = "fish";

    try {
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
      expect(slotSpy).toHaveBeenCalled();
      expect(fake.calls.length).toBeGreaterThan(0);
      const sent = fake.calls[0]!.text.length;
      expect(sent).toBeGreaterThanOrEqual(8_000);
      expect(timeouts[0]).toBe(sectionAttemptBudgetMs("fish", sent));
      expect(timeouts[0]!).toBeGreaterThanOrEqual(Math.ceil((sent / 37) * 1000));
      expect(fake.calls[0]?.signal?.aborted).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
      slotSpy.mockRestore();
    }
  });

  it("keeps heartbeating while an attempt is still inside its own deadline", async () => {
    const { coverLeaseUntil, shouldRenewTakehomeLease } = await import(
      "@/lib/tts/process-job"
    );
    const now = Date.now();
    const waveDeadlineMs = now - 8_000;
    expect(
      shouldRenewTakehomeLease({ now, waveDeadlineMs, jobId: JOB_ID })
    ).toBe(false);

    const cover = coverLeaseUntil(JOB_ID, now + 149_000);
    try {
      expect(
        shouldRenewTakehomeLease({
          now: Date.now(),
          waveDeadlineMs,
          jobId: JOB_ID,
        })
      ).toBe(true);
      cover.until(Date.now() - 1);
      expect(
        shouldRenewTakehomeLease({
          now: Date.now(),
          waveDeadlineMs,
          jobId: JOB_ID,
        })
      ).toBe(false);
    } finally {
      cover.end();
    }
  });
});

describe("releaseInFlightTakehomeLeases", () => {
  it("returns a hung take-home to queued and leaves another worker's lease", async () => {
    await seedTakehomeJob("A short paragraph for the stall.");
    const pdfPath = String((await jobRow(JOB_ID))?.pdf_storage_path);
    const otherId = "dddddddd-0000-4000-8000-000000000002";
    await seedJob({
      id: otherId,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "processing",
    });
    await execute(
      `UPDATE jobs SET processing_lease_token = ?, lease_expires_at = unixepoch() + 300
       WHERE id = ?`,
      ["foreign-token", otherId]
    );

    let rejectHang: (err: Error) => void = () => {};
    const hang = new Promise<never>((_, reject) => {
      rejectHang = reject;
    });
    const fake = await useProvider(() => hang);
    const { processTakehomeTick, releaseInFlightTakehomeLeases } = await import(
      "@/lib/tts/process-job"
    );
    const tick = processTakehomeTick(JOB_ID);
    try {
      for (let i = 0; i < 100; i++) {
        if (fake.calls.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fake.calls.length).toBeGreaterThan(0);
      expect(fake.calls[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(fake.calls[0]?.signal?.aborted).toBe(false);

      const released = await releaseInFlightTakehomeLeases();
      expect(released).toBe(1);
      const row = await jobRow(JOB_ID);
      expect(row?.status).toBe("queued");
      expect(row?.processing_lease_token).toBeNull();
      expect(row?.lease_expires_at).toBeNull();
      const other = await jobRow(otherId);
      expect(other?.status).toBe("processing");
      expect(other?.processing_lease_token).toBe("foreign-token");
    } finally {
      rejectHang(new Error("bad request"));
      await tick.catch(() => {});
    }
  });
});

describe("section lifecycle lease", () => {
  it("keeps the lease while mastering runs past the synth deadlines", async () => {
    await seedTakehomeJob("Chapter 1.\n\nThe harbor was quiet after the rain. ".repeat(40));
    const master = await import("@/lib/tts/section-master");
    let sawMaster = false;
    const masterSpy = vi
      .spyOn(master, "prepareSectionForStorage")
      .mockImplementation(async (audio, extension, contentType) => {
        sawMaster = true;
        const { shouldRenewTakehomeLease } = await import("@/lib/tts/process-job");
        // Synth attempt covers have already ended. The wave budget is over.
        // Mastering still has to hold the lease.
        expect(
          shouldRenewTakehomeLease({
            now: Date.now(),
            waveDeadlineMs: Date.now() - 1_000,
            jobId: JOB_ID,
          })
        ).toBe(true);
        await new Promise((r) => setTimeout(r, 30));
        return { audio, extension, contentType, mastered: true };
      });
    await useProvider();
    const { processTakehomeTick, shouldRenewTakehomeLease } = await import(
      "@/lib/tts/process-job"
    );
    try {
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
      expect(sawMaster).toBe(true);
      const row = await jobRow(JOB_ID);
      const segments = JSON.parse(String(row?.segments_json || "[]")) as Array<{
        status: string;
      }>;
      expect(segments.some((segment) => segment.status === "ready")).toBe(true);
      expect(
        shouldRenewTakehomeLease({
          now: Date.now(),
          waveDeadlineMs: Date.now() - 1_000,
          jobId: JOB_ID,
        })
      ).toBe(false);
    } finally {
      masterSpy.mockRestore();
    }
  });
});

describe("take-home fairness", () => {
  function longBook(): string {
    return Array.from(
      { length: 8 },
      (_, i) =>
        `Chapter ${i + 1}.\n\n${"The harbor was quiet after the rain. ".repeat(20)}`
    ).join("\n\n");
  }

  it("yields a resumable lease when another take-home is queued", async () => {
    await seedTakehomeJob(longBook());
    const pdfPath = String((await jobRow(JOB_ID))?.pdf_storage_path);
    const otherId = "dddddddd-0000-4000-8000-000000000099";
    await seedJob({
      id: otherId,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
    });
    await execute(`UPDATE jobs SET updated_at = unixepoch() - 120 WHERE id = ?`, [
      otherId,
    ]);
    await useProvider();
    const { runTakehomeUntilSettled, listDrainableTakehomeJobs } = await import(
      "@/lib/tts/process-job"
    );
    process.env.TTS_MAX_TICKS_PER_WAVE = "1";

    let first: { status: string };
    try {
    first = await runTakehomeUntilSettled(JOB_ID, 60_000);
    expect(first.status).toBe("yielded");
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("queued");
    expect(row?.processing_lease_token).toBeNull();
    const segments = JSON.parse(String(row?.segments_json || "[]")) as Array<{
      status: string;
      path?: string;
    }>;
    const ready = segments.filter((segment) => segment.status === "ready");
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.every((segment) => segment.path)).toBe(true);

    const order = await listDrainableTakehomeJobs();
    expect(order[0]).toBe(otherId);
    expect(order).toContain(JOB_ID);

    const second = await runTakehomeUntilSettled(JOB_ID, 8_000);
    expect(second.status).toBe("yielded");
    const again = JSON.parse(
      String((await jobRow(JOB_ID))?.segments_json || "[]")
    ) as Array<{ status: string; path?: string }>;
    for (const section of ready) {
      const kept = again.find((segment) => segment.path === section.path);
      expect(kept?.status).toBe("ready");
    }
    } finally {
      delete process.env.TTS_MAX_TICKS_PER_WAVE;
    }
  });

  it("finishes the book when no other take-home is queued", async () => {
    await seedTakehomeJob("A short chapter.\n\nThe harbor was quiet.");
    await useProvider();
    const { runTakehomeUntilSettled } = await import("@/lib/tts/process-job");
    const result = await runTakehomeUntilSettled(JOB_ID, 60_000);
    expect(result.status).toBe("ready");
    expect((await jobRow(JOB_ID))?.status).toBe("ready");
  });

  it("does not yield to a book that is still waiting on extract", async () => {
    await seedTakehomeJob("A short chapter.\n\nThe harbor was quiet.");
    const extractingId = "33333333-3333-4333-8333-333333333333";
    const extractingPath = `pdfs/${extractingId}/content.txt`;
    await execute(
      `INSERT INTO uploads (id, user_id, storage_path, file_name, format, status)
       VALUES (?, ?, ?, 'other.txt', 'txt', 'extracting')`,
      [extractingId, USER_A, extractingPath]
    );
    const waitingId = "dddddddd-0000-4000-8000-000000000098";
    await seedJob({
      id: waitingId,
      userId: USER_A,
      pdfStoragePath: extractingPath,
      status: "waiting",
    });
    await useProvider();
    const { runTakehomeUntilSettled } = await import("@/lib/tts/process-job");
    const result = await runTakehomeUntilSettled(JOB_ID, 60_000);
    expect(result.status).toBe("ready");
    expect((await jobRow(waitingId))?.status).toBe("waiting");
  });

  it("yields to a waiting book whose file is already read, and the claim runs it", async () => {
    await seedTakehomeJob(longBook());
    const otherPath = await seedUpload({
      id: "22222222-2222-4222-8222-222222222222",
      userId: USER_A,
      text: "A short chapter.\n\nThe harbor was quiet.",
    });
    const otherId = "dddddddd-0000-4000-8000-000000000097";
    await seedJob({
      id: otherId,
      userId: USER_A,
      pdfStoragePath: otherPath,
      status: "waiting",
    });
    await execute(`UPDATE jobs SET updated_at = unixepoch() - 120 WHERE id = ?`, [
      otherId,
    ]);
    await useProvider();
    const { runTakehomeUntilSettled, listDrainableTakehomeJobs } = await import(
      "@/lib/tts/process-job"
    );
    process.env.TTS_MAX_TICKS_PER_WAVE = "1";
    try {
      const first = await runTakehomeUntilSettled(JOB_ID, 60_000);
      expect(first.status).toBe("yielded");
      expect((await jobRow(otherId))?.status).toBe("waiting");
      expect((await listDrainableTakehomeJobs())[0]).toBe(otherId);

      delete process.env.TTS_MAX_TICKS_PER_WAVE;
      const claimed = await runTakehomeUntilSettled(otherId, 60_000);
      expect(claimed.status).toBe("ready");
      expect((await jobRow(otherId))?.status).toBe("ready");
    } finally {
      delete process.env.TTS_MAX_TICKS_PER_WAVE;
    }
  });

  it("yields to a waiting book whose extract failed so the claim fails it", async () => {
    await seedTakehomeJob(longBook());
    const failedUpload = "44444444-4444-4444-8444-444444444444";
    const failedPath = `pdfs/${failedUpload}/content.txt`;
    await execute(
      `INSERT INTO uploads (id, user_id, storage_path, file_name, format, status, error_message)
       VALUES (?, ?, ?, 'bad.txt', 'txt', 'failed', ?)`,
      [failedUpload, USER_A, failedPath, "This file took too long to read. Try again."]
    );
    const otherId = "dddddddd-0000-4000-8000-000000000096";
    await seedJob({
      id: otherId,
      userId: USER_A,
      pdfStoragePath: failedPath,
      status: "waiting",
    });
    await execute(`UPDATE jobs SET updated_at = unixepoch() - 120 WHERE id = ?`, [
      otherId,
    ]);
    await useProvider();
    const {
      runTakehomeUntilSettled,
      listDrainableTakehomeJobs,
      processTakehomeTick,
    } = await import("@/lib/tts/process-job");
    process.env.TTS_MAX_TICKS_PER_WAVE = "1";
    try {
      const first = await runTakehomeUntilSettled(JOB_ID, 60_000);
      expect(first.status).toBe("yielded");
      expect((await listDrainableTakehomeJobs())[0]).toBe(otherId);
      await processTakehomeTick(otherId);
      const row = await jobRow(otherId);
      expect(row?.status).toBe("failed");
      expect(row?.error_message).toBe(
        "This file took too long to read. Try again."
      );
      expect(row?.processing_lease_token).toBeNull();
    } finally {
      delete process.env.TTS_MAX_TICKS_PER_WAVE;
    }
  });
});
