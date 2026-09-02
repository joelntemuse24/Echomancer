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
      text: "A sentence. ".repeat(300),
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

describe("poll nudge budget", () => {
  it("defaults to read-only; a mis-set env is hard-capped at 45s", async () => {
    const { DEFAULT_POLL_NUDGE_BUDGET_MS, MAX_POLL_NUDGE_BUDGET_MS } =
      await import("@/lib/tts/process-job");
    expect(DEFAULT_POLL_NUDGE_BUDGET_MS).toBe(0);
    expect(MAX_POLL_NUDGE_BUDGET_MS).toBe(45_000);
  });
});

describe("runTakehomeWave short nudge", () => {
  it("still synthesizes section 0 when the budget is a short poll nudge", async () => {
    await seedTakehomeJob("Hello world. ".repeat(40));
    const fake = await useProvider();
    const { runTakehomeWave } = await import("@/lib/tts/process-job");

    // Matches the old Hobby default that previously parked before section 0.
    await runTakehomeWave(JOB_ID, 8_000);

    expect(fake.calls.length).toBeGreaterThanOrEqual(1);
    const row = await jobRow(JOB_ID);
    expect(Number(row?.next_section_index ?? 0)).toBeGreaterThan(0);
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
      return { audio: fakeMp3(512, index + 1), contentType: "audio/mpeg" };
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
      expect(String(row?.audio_storage_path)).toMatch(/\/full\./);
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
