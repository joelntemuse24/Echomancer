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
import { execute } from "@/lib/turso";

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
    expect(fake.calls[1]!.text).toContain("second chapter is also frozen");
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
      await runTaggedJob({
        id: "cccccccc-0000-4000-8000-000000000098",
        uploadId: "11111111-1111-4111-8111-111111111198",
        provider: "google",
        catalogVoiceId: "randolph",
        model: "en-GB-Neural2-O",
      });
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
