/**
 * Two books, one worker, caps that allow both.
 *
 * A failed claim used to stay inside runTakehomeUntilSettled for
 * TTS_MAX_WAVES_PER_RUN (80) instant waves. The drain had already started
 * both runners, so the loser filled the log with "another worker holds the
 * lease" and did not get a real turn until the winner finished.
 *
 * A side `modal run ::cover` is a second Modal input. With max_inputs=1 it
 * restores a container the book's /synthesize_batch does not join.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  UPLOAD_ID_B,
  USER_A,
  createFakeProvider,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";
import { TakehomeWorkerLoop } from "@/worker/takehome-loop";
import { modalCloneWarmHoldMs } from "@/lib/tts/providers/modal-clone-guard";
import {
  prewarmModalCloneSnapshot,
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "@/lib/tts/providers/modal-clone-warm";
import { cloneIdleScaledown } from "@/lib/tts/providers/modal-clone-guard";

const BOOK_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOOK_B = "bbbbbbbb-0000-4000-8000-0000000000b2";

const envKeys = [
  "TAKEHOME_MAX_INFLIGHT_PER_USER",
  "TAKEHOME_GLOBAL_ACTIVE",
  "WORKER_CONCURRENCY",
  "WORKER_LOCAL_MULTIBOOK",
  "TTS_MAX_WAVES_PER_RUN",
  "TTS_MAX_TICKS_PER_WAVE",
  "TTS_SECTION_QA_ENABLED",
  "MODAL_TOKEN_ID",
  "MODAL_S2_WARM_HOLD_MS",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function countLogs(lines: string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length;
}

async function seedPair(
  textA = "A short chapter.\n\nThe harbor was quiet.",
  textB = textA
) {
  const pathA = await seedUpload({ id: UPLOAD_ID_A, userId: USER_A, text: textA });
  const pathB = await seedUpload({ id: UPLOAD_ID_B, userId: USER_A, text: textB });
  await seedJob({ id: BOOK_A, userId: USER_A, pdfStoragePath: pathA });
  await seedJob({ id: BOOK_B, userId: USER_A, pdfStoragePath: pathB });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  savedEnv = {};
  for (const key of envKeys) savedEnv[key] = process.env[key];
  process.env.TTS_SECTION_QA_ENABLED = "0";
  process.env.TTS_MAX_WAVES_PER_RUN = "80";
  delete process.env.TTS_MAX_TICKS_PER_WAVE;
  delete process.env.MODAL_S2_WARM_HOLD_MS;
});

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetModalCloneWarmForTests();
  setModalCloneWarmSpawnerForTests(null);
});

describe("lease contention", () => {
  it("stops after one wave when another worker already holds the lease", async () => {
    const pathB = await seedUpload({
      id: UPLOAD_ID_B,
      userId: USER_A,
      text: "A short chapter.\n\nThe harbor was quiet.",
    });
    await seedJob({ id: BOOK_B, userId: USER_A, pdfStoragePath: pathB });
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "2";
    process.env.TAKEHOME_GLOBAL_ACTIVE = "2";
    await execute(
      `UPDATE jobs SET status = 'processing', processing_lease_token = 'owner-token',
         lease_expires_at = unixepoch() + 90 WHERE id = ?`,
      [BOOK_B]
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const { runTakehomeUntilSettled } = await import("@/lib/tts/process-job");
    const result = await runTakehomeUntilSettled(BOOK_B, 60_000);
    expect(result.status).toBe("busy");
    expect(countLogs(lines, "take-home wave starting")).toBe(1);
    expect(countLogs(lines, "another worker holds the lease")).toBe(1);
    const row = await jobRow(BOOK_B);
    expect(row?.processing_lease_token).toBe("owner-token");
    expect(row?.status).toBe("processing");
  }, 20_000);

  it("does not spin when the per-user cap already has this user's other book", async () => {
    await seedPair();
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "1";
    process.env.TAKEHOME_GLOBAL_ACTIVE = "2";
    await execute(
      `UPDATE jobs SET status = 'processing', processing_lease_token = 'owner-a',
         lease_expires_at = unixepoch() + 90 WHERE id = ?`,
      [BOOK_A]
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const { runTakehomeUntilSettled } = await import("@/lib/tts/process-job");
    const result = await runTakehomeUntilSettled(BOOK_B, 60_000);
    expect(result.status).toBe("busy");
    expect(countLogs(lines, "take-home wave starting")).toBe(1);
    expect(countLogs(lines, "inflight cap is full")).toBe(1);
    expect(countLogs(lines, "another worker holds the lease")).toBe(0);
    const row = await jobRow(BOOK_B);
    expect(row?.status).toBe("queued");
    expect(row?.processing_lease_token).toBeNull();
  }, 20_000);
});

describe("two books overlap when the caps allow it", () => {
  it("synthesizes both at once and keeps each lease to one owner", async () => {
    await seedPair("The harbor was quiet after the rain.");
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "2";
    process.env.TAKEHOME_GLOBAL_ACTIVE = "2";
    process.env.WORKER_CONCURRENCY = "2";
    process.env.WORKER_LOCAL_MULTIBOOK = "1";
    let entered = 0;
    let releaseBoth!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const providers = await import("@/lib/tts/providers");
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(
      createFakeProvider(async () => {
        entered += 1;
        await both;
        return { audio: fakeMp3(), contentType: "audio/mpeg" };
      })
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const seen = new Map<string, string>();
    const { runTakehomeUntilSettled, listDrainableTakehomeJobs } = await import(
      "@/lib/tts/process-job"
    );
    const loop = new TakehomeWorkerLoop({
      concurrency: 2,
      budgetMs: 60_000,
      runner: {
        runUntilSettled: async (jobId) => {
          const row = await jobRow(jobId);
          const token = row?.processing_lease_token;
          if (typeof token === "string" && token) {
            const owner = seen.get(jobId);
            if (owner && owner !== token) {
              throw new Error(`job ${jobId} changed lease owner`);
            }
          }
          const result = await runTakehomeUntilSettled(jobId, 60_000);
          const after = await jobRow(jobId);
          const held = after?.processing_lease_token;
          if (typeof held === "string" && held) seen.set(jobId, held);
          return result;
        },
        listDrainable: listDrainableTakehomeJobs,
        releaseExpired: async () => 0,
      },
      log: { info: () => {}, error: () => {} },
    });
    await loop.drain();
    await vi.waitFor(() => expect(entered).toBe(2), { timeout: 15_000 });
    const live = await Promise.all([jobRow(BOOK_A), jobRow(BOOK_B)]);
    const tokens = live.map((row) => row?.processing_lease_token);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(live.every((row) => row?.status === "processing")).toBe(true);
    releaseBoth();
    await loop.waitIdle(20_000);
    expect((await jobRow(BOOK_A))?.status).toBe("ready");
    expect((await jobRow(BOOK_B))?.status).toBe("ready");
    expect(countLogs(lines, "another worker holds the lease")).toBe(0);
    expect(countLogs(lines, "take-home wave starting")).toBeLessThan(10);
    loop.stop();
  }, 30_000);

  it("picks the second book up while the first is still generating", async () => {
    await seedPair(
      "Chapter one.\n\n" + "The harbor was quiet after the rain. ".repeat(40),
      "A short chapter.\n\nThe second harbor was quiet."
    );
    process.env.TAKEHOME_MAX_INFLIGHT_PER_USER = "2";
    process.env.TAKEHOME_GLOBAL_ACTIVE = "2";
    process.env.WORKER_CONCURRENCY = "2";
    process.env.WORKER_LOCAL_MULTIBOOK = "1";
    process.env.TTS_MAX_TICKS_PER_WAVE = "1";
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let startedB = false;
    const providers = await import("@/lib/tts/providers");
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(
      createFakeProvider(async (input) => {
        if (input.text.includes("Chapter one")) {
          await gateA;
        } else {
          startedB = true;
        }
        return { audio: fakeMp3(), contentType: "audio/mpeg" };
      })
    );
    const { runTakehomeUntilSettled, listDrainableTakehomeJobs } = await import(
      "@/lib/tts/process-job"
    );
    const loop = new TakehomeWorkerLoop({
      concurrency: 2,
      budgetMs: 60_000,
      runner: {
        runUntilSettled: (jobId, budgetMs) => runTakehomeUntilSettled(jobId, budgetMs),
        listDrainable: listDrainableTakehomeJobs,
        releaseExpired: async () => 0,
      },
      log: { info: () => {}, error: () => {} },
    });
    const drain = await loop.drain();
    expect(drain.started.sort()).toEqual([BOOK_A, BOOK_B].sort());
    await vi.waitFor(() => expect(startedB).toBe(true), { timeout: 15_000 });
    expect((await jobRow(BOOK_A))?.status).toBe("processing");
    releaseA();
    await loop.waitIdle(20_000);
    loop.stop();
  }, 30_000);
});

describe("clone containers", () => {
  it("does not start a side cover for a book that will synthesize", () => {
    const spawned: string[][] = [];
    resetModalCloneWarmForTests();
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    process.env.MODAL_TOKEN_ID = "test-token";
    expect(
      prewarmModalCloneSnapshot("book A is starting", 1_000, {
        jobId: BOOK_A,
        userId: USER_A,
        leases: [],
      })
    ).toBe(false);
    expect(
      prewarmModalCloneSnapshot("book B is starting", 2_000, {
        jobId: BOOK_B,
        userId: USER_A,
        leases: [{ jobId: BOOK_A, userId: USER_A }],
      })
    ).toBe(false);
    expect(prewarmModalCloneSnapshot("voice list", 3_000)).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("lets the last finished book go by scaledown and does not spawn", () => {
    expect(modalCloneWarmHoldMs({} as NodeJS.ProcessEnv)).toBeLessThan(45_000);
    expect(modalCloneWarmHoldMs({} as NodeJS.ProcessEnv)).toBeGreaterThan(0);
    const idle = cloneIdleScaledown({ bookSettled: true, otherLiveGpuLeases: 0 });
    expect(idle).toEqual({
      releaseContainer: true,
      spawn: false,
      mechanism: "scaledown_window",
      scaledownSeconds: 45,
    });
    expect(
      cloneIdleScaledown({ bookSettled: true, otherLiveGpuLeases: 1 }).releaseContainer
    ).toBe(false);
  });
});
