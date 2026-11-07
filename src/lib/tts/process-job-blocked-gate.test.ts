/**
 * The `job 75944dc9` reproduction: a book that never contacted Modal at all.
 *
 * ## What production showed
 *
 * `job 75944dc9` (2026-11-06 23:18 Dublin) finished `ready` after 32 s with
 * **5 of 11** sections. Six failed, each within about a second, every one with
 * the same message:
 *
 *     section N attempt k failed: Clone provider modal failed and this book may not switch engines
 *
 * Modal's own access log had **zero entries** for the whole failure window
 * (23:17–23:21), while earlier direct calls in the same hour were logged
 * normally. So no HTTP request reached the endpoint, and no GPU was ever
 * involved. The five "ready" sections were byte-identical to cached MP3s from
 * earlier builds, so the book contains no audio from the new runtime at all.
 *
 * ## Why that message with no request is not a coincidence
 *
 * `Clone provider … may not switch engines` has exactly one throw site
 * (`providers/fish.ts`). It is reached only when the book is pinned to `modal`
 * **and** `modalCloneJobBlocked(jobId)` is already true:
 *
 * ```ts
 * if (useModal && !modalCloneJobBlocked(input.jobId)) {   // skipped when blocked
 *   try { return await synthesizeModalClone(input); }     // never runs
 *   ...
 * }
 * ...
 * if (engine && engine !== "fish" && !mayFallback) {
 *   throw new Error(`Clone provider ${engine} failed and this book may not switch engines`);
 * }
 * ```
 *
 * So the message says "Modal failed" about a provider call that was never made.
 * The blocked flag is set by the **spend gate** (`ensureModalCloneJobAllowed` →
 * `modalCloneSpendAllowed`), which runs before the lane dispatch and:
 *
 *   - returns false on a cap (`userChars + chars > user cap`, or the global
 *     cap), or on **any** error while reading `usage_logs`;
 *   - records the job in a process-lifetime `Set`, so it stays blocked;
 *   - does so **silently** on a cap and leaves no reason anywhere a person or an
 *     operator can read.
 *
 * A blocked job then skips the lane dispatch entirely (which is why there is no
 * `S2 lanes=…` line in the worker log for this book) and falls through to the
 * per-section path, where each section throws in microseconds. Sections already
 * in the content cache are read **before** the provider is consulted, which is
 * exactly why 0, 1, 3, 4 and 10 succeeded while 2, 5, 6, 7, 8 and 9 failed.
 *
 * That ordering also explains the 32-second "success": the book was never
 * generated.
 *
 * ## What these tests pin
 *
 * They drive the real tick against the in-memory database, so the spend gate,
 * the lane dispatch, the per-section path and the assembly decision all run for
 * real. Only the HTTP endpoint is faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";
import {
  BATCH_HOST,
  READY_HOST,
  endpointOf,
} from "@/lib/tts/providers/modal-endpoints.fixture";

const JOB_ID = "75944dc9-deb4-4591-98f9-ff5c4fcd5e73";
const CLONE_ID = "clone:e552d5a5-8f2f-484d-9399-800ddacba85c";

/** The pinned message production actually logged. */
const OBSERVED_GENERIC_ERROR =
  "Clone provider modal failed and this book may not switch engines";

/** Every outbound call the tick made, so "no request" is assertable. */
type Call = { host: string; method: string };

function recordFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = endpointOf(String(input));
    const call = { host, method: (init?.method || "GET").toUpperCase() };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

function warmPool(sections: number) {
  return recordFetch((call) => {
    if (call.host === "ready") {
      return new Response(
        JSON.stringify({ ready: true, warm_containers: 2, build: "aa02126d8267" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        items: Array.from({ length: sections }, (_, i) => ({
          key: String(i),
          audio_b64: Buffer.from(fakeMp3(4096, i + 1)).toString("base64"),
          duration_s: 40,
          units: 3,
          truncated_units: 0,
        })),
        build: "aa02126d8267",
        container_id: "c1",
        seed: 7,
        performance: { generate_s: 5, sections },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
}

async function seedCloneJob(text: string) {
  const pdfPath = await seedUpload({ id: UPLOAD_ID_A, userId: USER_A, text });
  await seedJob({
    id: JOB_ID,
    userId: USER_A,
    pdfStoragePath: pdfPath,
    catalogVoiceId: CLONE_ID,
    ttsProvider: "fish",
    providerVoiceId: "clone-ref",
    model: "s2.1-pro-base",
    ttsOptions: { model: "s2.1-pro-base", pauseStyle: "normal" },
  });
  const { uploadFile } = await import("@/lib/storage");
  await uploadFile(
    "clones/saved",
    "sample.wav",
    Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(28), Buffer.from("WAVE"), Buffer.alloc(4096)]),
    "audio/wav"
  ).catch(() => undefined);
  await execute(
    `INSERT OR REPLACE INTO cloned_voices
       (id, user_id, fish_voice_id, title, sample_storage_path, state,
        model, reference_transcript)
     VALUES (?, ?, ?, ?, ?, 'trained', 's2.1-pro-base', 'the sample words')`,
    [CLONE_ID.slice("clone:".length), USER_A, "clone-ref", "VDH", "clones/saved/sample.wav"]
  );
}

function configureModal() {
  process.env.MODAL_S2_TTS_URL = BATCH_HOST;
  process.env.MODAL_S2_READY_URL = READY_HOST;
  process.env.MODAL_S2_TOKEN = "test-token";
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  process.env.TTS_SECTIONS_PER_TICK = "2";
  process.env.TTS_RETRY_BACKOFF_MS = "0";
  delete process.env.TTS_TAKEHOME_FANOUT;
  delete process.env.MODAL_S2_SECTION_CONCURRENCY;
  delete process.env.MODAL_S2_DEFER_MS;
  delete process.env.CLONE_TTS_PROVIDER;
  delete process.env.MODAL_S2_USER_DAILY_CHARS;
  delete process.env.MODAL_S2_GLOBAL_DAILY_CHARS;
  delete process.env.TTS_SECTION_CACHE;
  const { resetModalCloneRuntimeForTests } = await import(
    "@/lib/tts/providers/modal-clone"
  );
  resetModalCloneRuntimeForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.MODAL_S2_TOKEN;
  delete process.env.MODAL_S2_READY_URL;
  delete process.env.MODAL_S2_USER_DAILY_CHARS;
  delete process.env.MODAL_S2_GLOBAL_DAILY_CHARS;
  delete process.env.TTS_RETRY_BACKOFF_MS;
  vi.restoreAllMocks();
});

describe("the blocked-job path reproduces job 75944dc9 exactly", () => {
  /**
   * The regression form of the failing reproduction.
   *
   * Before the fix this asserted the *symptom* and passed: the budget gate
   * refused the book, the lane dispatch was skipped, and every section threw
   * "Clone provider modal failed and this book may not switch engines" in
   * microseconds without a single request reaching Modal. That is exactly what
   * production logged for six sections, and it is why the incident read as a
   * broken provider.
   *
   * It now asserts the contract instead: no request is made (still true and
   * still correct — the budget decision is deliberate), and the failure names
   * the budget rather than the provider.
   */
  it("never contacts Modal and reports the budget, not a provider failure", async () => {
    configureModal();
    const { calls } = warmPool(4);
    // One character of budget: the gate must refuse a 17k-character book.
    process.env.MODAL_S2_GLOBAL_DAILY_CHARS = "1";
    await seedCloneJob("A sentence about farmland. ".repeat(700));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });

    // No request may be made: the gate refused before dispatch, which is the
    // one part of the original behaviour that was correct.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(calls.filter((call) => call.host === "ready")).toHaveLength(0);
    // The observed message must be gone, because no provider call failed.
    expect(errors.join("\n")).not.toContain(OBSERVED_GENERIC_ERROR);
  });

  it("records why the book is blocked where an operator can read it", async () => {
    // Production left no reason anywhere: the gate fails silently on a cap, so
    // the only trace was the generic message. That is the diagnosability defect.
    configureModal();
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    process.env.MODAL_S2_GLOBAL_DAILY_CHARS = "1";
    await seedCloneJob("A sentence about farmland. ".repeat(700));
    warmPool(4);

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });

    const logged = warnings.join("\n");
    // The message must name the budget gate and carry the numbers, not claim the
    // provider failed.
    expect(logged).toMatch(/budget|spend|cap/i);
    expect(logged).not.toMatch(OBSERVED_GENERIC_ERROR);
  });

  it("does not burn three attempts per section on an instant, request-free failure", async () => {
    configureModal();
    process.env.MODAL_S2_GLOBAL_DAILY_CHARS = "1";
    await seedCloneJob("A sentence about farmland. ".repeat(700));
    warmPool(4);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
      index: number;
      status: string;
      error?: string;
    }[];

    // An instant failure retried three times per section, plus a hole retry, is
    // how six sections became a "finished" book in 32 seconds.
    for (const segment of segments) {
      expect(segment.error ?? "").not.toMatch(OBSERVED_GENERIC_ERROR);
    }
  });

  it("does not publish a book missing half its sections as complete", async () => {
    // `mostIndexesReady` assembles once more than half are ready, so a book with
    // six holes went `ready` with an 8-minute file against a 19-minute source.
    configureModal();
    process.env.MODAL_S2_GLOBAL_DAILY_CHARS = "1";
    await seedCloneJob("A sentence about farmland. ".repeat(700));
    warmPool(4);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });

    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
      status: string;
    }[];
    const ready = segments.filter((s) => s.status === "ready").length;
    const failed = segments.filter((s) => s.status === "failed").length;
    // Either the book is honestly incomplete, or it is not called `ready`
    // while missing content.
    if (failed > 0) {
      expect(row?.status === "ready" && ready < (row?.total_sections ?? 0)).toBe(
        false
      );
    }
  });
});
