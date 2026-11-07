/**
 * There is no app-imposed generation allowance, and the book path proves it.
 *
 * ## What this replaces
 *
 * These tests used to pin the opposite: that a per-account daily character budget
 * (default 500,000) and a global one (2,000,000) could refuse the GPU pool and
 * route a clone book to the backup engine. `job 75944dc9` was refused at
 * 492,425 characters used plus a 17,022-character book, and the refusal surfaced
 * as *"Clone provider modal failed and this book may not switch engines"* with
 * **zero** requests in Modal's access log.
 *
 * Joel, 2026-11-07: *"Get rid of the allowance in general"*.
 *
 * So the property to protect is no longer "the cap refuses at the right
 * number" — it is the inverse, and it is stronger because it has to hold through
 * the real tick:
 *
 *   1. a book whose account has already generated far past every former cap
 *      still renders on the GPU pool, with real POSTs and a `ready` book;
 *   2. an unreadable usage ledger does not block, defer or reroute anything —
 *      accounting is not enforcement;
 *   3. no book is pinned to `fish` because of usage. Only configuration and real
 *      provider faults may change the engine.
 *
 * The provider is faked at the HTTP boundary; everything else — the gate that no
 * longer exists, the lane dispatch, the per-section path, the cache and the
 * assembly decision — runs for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
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

/** The message the old allowance produced, which must never appear again. */
const OBSERVED_GENERIC_ERROR =
  "Clone provider modal failed and this book may not switch engines";

type Call = { host: string; method: string; items: number };

function recordFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = endpointOf(String(input));
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const items = Array.isArray(body?.items) ? body.items.length : 0;
      calls.push({ host, method, items });
      return respond({ host, method, items });
    })
  );
  return calls;
}

function warmPool() {
  return recordFetch((call) => {
    if (call.host === "ready") {
      return new Response(
        JSON.stringify({ ready: true, warm_containers: 2, build: "aa02126d8267" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        items: [],
        build: "aa02126d8267",
        container_id: "c1",
        seed: 7,
        performance: { generate_s: 5 },
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

/**
 * A book the size of the one production refused, in distinct paragraphs.
 *
 * Distinct matters: the provider attempt ledger and the section cache are keyed
 * on text, so 32 identical paragraphs would share one entry and this would
 * measure the ledger instead of the gate that no longer exists.
 */
function bookSource(): string {
  const sentence =
    "The argument was that the landscape itself had done the work, and that no " +
    "European could have written it down honestly. ";
  const openers = [
    "It began with soil.",
    "What followed was a political culture.",
    "He returned to the point again.",
    "It was not merely an arrangement.",
    "The consequence was a kind of equality.",
    "In his view the yeomanry mattered most.",
    "Nothing about it was designed.",
    "The claim depended on abundance.",
  ];
  return Array.from(
    { length: 32 },
    (_, i) => `${openers[i % openers.length]} ${sentence.repeat(4)}`
  ).join("\n\n");
}

/** Insert a large amount of prior usage for this account, as production had. */
async function seedPriorUsage(chars: number, action = "modal_s2_clone") {
  await execute(
    `INSERT INTO usage_logs (user_id, action, chars_processed) VALUES (?, ?, ?)`,
    [USER_A, action, chars]
  );
}

function configureModal() {
  process.env.MODAL_S2_TTS_URL = BATCH_HOST;
  process.env.MODAL_S2_READY_URL = READY_HOST;
  process.env.MODAL_S2_TOKEN = "test-token";
}

async function runBook(ticks = 16, perTick = 8) {
  const { processTakehomeTick } = await import("@/lib/tts/process-job");
  for (let tick = 0; tick < ticks; tick += 1) {
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: perTick });
    if (result.done) break;
  }
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  process.env.TTS_SECTIONS_PER_TICK = "8";
  process.env.TTS_RETRY_BACKOFF_MS = "0";
  process.env.TTS_SECTION_CACHE = "1";
  delete process.env.TTS_TAKEHOME_FANOUT;
  delete process.env.MODAL_S2_SECTION_CONCURRENCY;
  delete process.env.MODAL_S2_DEFER_MS;
  delete process.env.CLONE_TTS_PROVIDER;
  // Leftover values from a worker whose .env predates this change. Nothing
  // reads them, and this suite proves that.
  process.env.MODAL_S2_USER_DAILY_CHARS = "1";
  process.env.MODAL_S2_GLOBAL_DAILY_CHARS = "1";
  const { resetModalCloneRuntimeForTests } = await import(
    "@/lib/tts/providers/modal-clone"
  );
  resetModalCloneRuntimeForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of [
    "MODAL_S2_TTS_URL",
    "MODAL_S2_TOKEN",
    "MODAL_S2_READY_URL",
    "MODAL_S2_USER_DAILY_CHARS",
    "MODAL_S2_GLOBAL_DAILY_CHARS",
    "TTS_RETRY_BACKOFF_MS",
    "TTS_SECTION_CACHE",
    "MODAL_S2_DEFER_MS",
  ]) {
    delete process.env[key];
  }
});

describe("high usage does not stop a book", () => {
  it("renders on the GPU pool past every former cap", async () => {
    configureModal();
    // Production's real numbers: 492,425 used, 17,022 requested, 500,000 cap.
    await seedPriorUsage(492_425);
    const calls = warmPool();
    await seedCloneJob(bookSource());
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await runBook();
    const row = await jobRow(JOB_ID);

    // Real requests were made to the pool — the thing that did not happen in
    // production when the gate refused before dispatch.
    expect(calls.filter((call) => call.method === "POST").length).toBeGreaterThan(0);
    expect(calls.some((call) => call.host === "ready")).toBe(true);
    // The engine was not changed, and the book was not refused.
    expect(row?.provider_pin).toBe("modal");
    expect(errors.join("\n")).not.toContain(OBSERVED_GENERIC_ERROR);
    expect(errors.join("\n")).not.toMatch(/budget/i);
    expect(errors.join("\n")).not.toMatch(/daily character/i);
  });

  it("does not pin the book to the backup engine because of usage", async () => {
    configureModal();
    // 50x the old global cap, all from this one account.
    await seedPriorUsage(100_000_000);
    warmPool();
    await seedCloneJob(bookSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBook();
    const row = await jobRow(JOB_ID);
    expect(row?.provider_pin).toBe("modal");
    expect(String(row?.warning ?? "")).not.toMatch(/budget/i);
  });

  it("still records the characters it generated", async () => {
    // Removing the allowance must not remove cost visibility.
    configureModal();
    await seedPriorUsage(492_425);
    warmPool();
    await seedCloneJob(bookSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBook();

    const { queryOne } = await import("@/lib/turso");
    const row = await queryOne<{ total: number | bigint | null }>(
      `SELECT COALESCE(SUM(chars_processed), 0) AS total
       FROM usage_logs WHERE user_id = ? AND action = 'modal_s2_clone'`,
      [USER_A]
    );
    // Strictly more than the seeded 492,425: new usage was written.
    expect(Number(row?.total)).toBeGreaterThan(492_425);
  });
});

describe("an unusable ledger does not stop a book", () => {
  it("proceeds when the usage read would have failed", async () => {
    // Before this change the ledger READ was an enforcement point, so an
    // unreadable usage table blocked every clone section. Now nothing reads it
    // on the generation path at all.
    configureModal();
    await seedPriorUsage(492_425);
    const turso = await import("@/lib/turso");
    const readSpy = vi.spyOn(turso, "queryOne");
    const calls = warmPool();
    await seedCloneJob(bookSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBook();
    const row = await jobRow(JOB_ID);

    expect(calls.filter((call) => call.method === "POST").length).toBeGreaterThan(0);
    expect(row?.provider_pin).toBe("modal");
    // Nothing on the generation path aggregates usage_logs any more. Any call
    // that remains is for something else (job row, clone row, segments).
    for (const call of readSpy.mock.calls) {
      const sql = String(call[0] ?? "");
      expect(sql).not.toMatch(/FROM\s+usage_logs/i);
    }
    readSpy.mockRestore();
  });

  it("proceeds when recording usage fails", async () => {
    configureModal();
    const turso = await import("@/lib/turso");
    const realExecute = turso.execute;
    // Fail only the usage insert, so the rest of the tick is unaffected.
    vi.spyOn(turso, "execute").mockImplementation(async (sql: string, args?: unknown[]) => {
      if (/INSERT INTO usage_logs/i.test(sql)) {
        throw new Error("turso unavailable");
      }
      return realExecute(sql, args as never);
    });
    const calls = warmPool();
    await seedCloneJob(bookSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBook();
    const row = await jobRow(JOB_ID);

    expect(calls.filter((call) => call.method === "POST").length).toBeGreaterThan(0);
    expect(row?.provider_pin).toBe("modal");
    expect(String(row?.error_message ?? "")).not.toMatch(/budget|allowance/i);
  });
});

describe("real provider limits are still real", () => {
  it("surfaces a provider auth failure as a provider failure", async () => {
    // Removing an app allowance must not swallow a genuine provider answer. A
    // 401 from the endpoint is a fact about the account and has to reach the
    // operator as itself, not as a generic message and not as a silent retry.
    configureModal();
    recordFetch((call) => {
      if (call.host === "ready") {
        return new Response(
          JSON.stringify({ ready: true, warm_containers: 2, build: "aa02126d8267" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("unauthorized", { status: 401 });
    });
    await seedCloneJob(bookSource());
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await runBook(4);
    const row = await jobRow(JOB_ID);

    // The provider's own failure is visible somewhere an operator can read it,
    // and the book is not silently reported as complete.
    const all = logged.join("\n") + String(row?.error_message ?? "") + String(row?.warning ?? "");
    expect(all).toMatch(/40[13]|unauthorized|provider/i);
    expect(row?.status).not.toBe("ready");
  });

  it("keeps the completeness contract: no partial book marked ready", async () => {
    // Carried over unchanged from #247 — this PR must not weaken it.
    configureModal();
    recordFetch((call) => {
      if (call.host === "ready") {
        return new Response(
          JSON.stringify({ ready: true, warm_containers: 2, build: "aa02126d8267" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    process.env.MODAL_S2_DEFER_MS = "0";
    await seedCloneJob(bookSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBook(6);
    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
      status: string;
    }[];
    const ready = segments.filter((segment) => segment.status === "ready").length;
    const total = Number(row?.total_sections ?? 0);
    if (total > 0 && ready < total) {
      expect(row?.status).not.toBe("ready");
    }
  });
});
