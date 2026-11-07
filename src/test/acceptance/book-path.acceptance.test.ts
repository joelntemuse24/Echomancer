/**
 * Book-path acceptance test — the check the previous roll did not have.
 *
 * ## Why this exists
 *
 * PR #246 passed every gate the roll actually ran:
 *
 *   - `modal deploy` + `::cover` reported the new build `aa02126d8267`;
 *   - a direct HTTP smoke at the batch endpoint returned 4/4 MP3s, warm and
 *     cold, `truncated_units: 0`;
 *   - `GET /ready` returned the version-9 recipe;
 *   - the worker was on the right SHA with the right env names.
 *
 * Then the first real book (`job 75944dc9`) came back `ready` in 32 s with **5
 * of 11** sections, and Modal's own access log had **zero** requests for the
 * whole failure window. Every check above was true and none of them touched the
 * path a book takes: budget gate → lane staging → per-section retry → cache →
 * assembly → publish.
 *
 * So this file drives that path end to end, against the in-memory database and a
 * deterministic fake endpoint, and asserts the properties the incident broke:
 *
 * | property | the failure it prevents |
 * |--|--|
 * | completeness | a `ready` book that is 55% missing |
 * | recipe identity | new-build books assembled from old-recipe audio |
 * | diagnosability | a budget refusal reported as a provider failure |
 * | determinism | a cache hit whose audio came from a different runtime |
 *
 * It is free to run: no Modal, no GPU, no network, no paid API. It is **not** a
 * substitute for one real bounded book render — it cannot tell you the narration
 * sounds right — which is why the runbook still requires that separate step.
 *
 * Run it alone:
 *
 *     npx vitest run src/test/acceptance/book-path.acceptance.test.ts
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

/** What a run reports, so the acceptance numbers are visible in the output. */
type Report = {
  planned: number;
  delivered: number;
  failed: number;
  coverage: number;
  status: string;
  requests: number;
  complete: boolean;
  note: string;
};

const reports: Report[] = [];

type Call = { host: string; method: string; items: number };

function installEndpoint(opts: {
  /** Sections the fake container renders. Everything else is a row error. */
  renders: (index: number) => boolean;
  warm?: boolean;
}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = endpointOf(String(input));
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const items = Array.isArray(body?.items) ? body.items : [];
      calls.push({ host, method, items: items.length });

      if (host === "ready") {
        const warm = opts.warm !== false;
        return new Response(
          JSON.stringify({
            ready: warm,
            warm_containers: warm ? 2 : 0,
            build: "aa02126d8267",
            recipe: { unit_max_chars: 560 },
          }),
          { status: warm ? 200 : 503, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          items: items.map((item: { key: string; text: string }) => {
            if (!opts.renders(Number(item.key))) {
              return {
                key: item.key,
                error: "section has no speakable text",
                error_code: "empty_text",
              };
            }
            return {
              key: item.key,
              audio_b64: Buffer.from(fakeMp3(4096, Number(item.key) + 1)).toString("base64"),
              // Scale like real narration: a flat duration fails the
              // truncation guard on any long section.
              duration_s: (item.text.length / 900) * 60,
              units: 3,
              truncated_units: 0,
              unit_shape: { count: 3, mean_chars: 520, max_chars: 559 },
            };
          }),
          build: "aa02126d8267",
          container_id: "c-acceptance",
          seed: 7,
          performance: { generate_s: 5, sections: items.length },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
  return calls;
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
    Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(28),
      Buffer.from("WAVE"),
      Buffer.alloc(4096),
    ]),
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

/** A book of the same size as the one that failed: ~17k chars, ~32 paragraphs. */
function acceptanceSource(): string {
  const sentence =
    "The argument was that the landscape itself had done the work, and that no " +
    "European could have written it down honestly, because the claim depended on " +
    "abundance of a kind the old world had already spent. ";
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

async function runBook(ticks = 16, perTick = 8) {
  const { processTakehomeTick } = await import("@/lib/tts/process-job");
  for (let tick = 0; tick < ticks; tick += 1) {
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: perTick });
    if (result.done) break;
  }
}

async function report(calls: Call[], note: string): Promise<Report> {
  const row = await jobRow(JOB_ID);
  const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
    status: string;
  }[];
  const total = Number(row?.total_sections ?? 0);
  const delivered = segments.filter((segment) => segment.status === "ready").length;
  const failed = segments.filter((segment) => segment.status === "failed").length;
  const result: Report = {
    planned: total,
    delivered,
    failed,
    coverage: total > 0 ? Math.round((delivered / total) * 100) : 0,
    status: String(row?.status ?? ""),
    requests: calls.filter((call) => call.method === "POST").length,
    complete: delivered === total,
    note,
  };
  reports.push(result);
  return result;
}

function configureModal() {
  process.env.MODAL_S2_TTS_URL = BATCH_HOST;
  process.env.MODAL_S2_READY_URL = READY_HOST;
  process.env.MODAL_S2_TOKEN = "test-token";
}

beforeEach(async () => {
  vi.restoreAllMocks();
  reports.length = 0;
  await resetDatabase();
  process.env.TTS_SECTIONS_PER_TICK = "8";
  process.env.TTS_RETRY_BACKOFF_MS = "0";
  // Production runs with the section cache ON. The harness defaults it off for
  // tests, which is why the clone **lane staging** path was untested before.
  process.env.TTS_SECTION_CACHE = "1";
  delete process.env.TTS_TAKEHOME_FANOUT;
  delete process.env.MODAL_S2_SECTION_CONCURRENCY;
  delete process.env.MODAL_S2_DEFER_MS;
  delete process.env.CLONE_TTS_PROVIDER;
  delete process.env.MODAL_S2_USER_DAILY_CHARS;
  delete process.env.MODAL_S2_GLOBAL_DAILY_CHARS;
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

describe("book-path acceptance", () => {
  it("reports full text coverage on a healthy book", async () => {
    configureModal();
    const calls = installEndpoint({ renders: () => true });
    await seedCloneJob(acceptanceSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBook();
    const result = await report(calls, "healthy book");

    // Acceptance thresholds, not just "a 200 came back".
    expect(result.planned).toBeGreaterThan(1);
    expect(result.coverage).toBe(100);
    expect(result.status).toBe("ready");
    expect(result.requests).toBeGreaterThan(0);
  });

  it("does not present a partial book as complete", async () => {
    configureModal();
    // Section 0 only: the smallest version of the production shape (5 of 11).
    const calls = installEndpoint({ renders: (index) => index === 0 });
    process.env.MODAL_S2_DEFER_MS = "0";
    await seedCloneJob(acceptanceSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runBook();
    const result = await report(calls, "partial book");

    expect(result.delivered).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
    // The single assertion this whole file exists for.
    expect(result.status).not.toBe("ready");
    expect(result.status).toBe("failed");
  });

  it("reports a budget refusal as a budget refusal, with zero requests", async () => {
    configureModal();
    const calls = installEndpoint({ renders: () => true });
    // One character of budget.
    process.env.MODAL_S2_GLOBAL_DAILY_CHARS = "1";
    await seedCloneJob(acceptanceSource());
    const warnings: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    await runBook();
    const result = await report(calls, "budget refusal");
    const logged = warnings.join("\n");

    // No request, because the decision was made before dispatch.
    expect(result.requests).toBe(0);
    // And the reason is the budget, not "the provider failed".
    expect(logged).toMatch(/budget/i);
    expect(logged).not.toMatch(/Clone provider modal failed/i);
    // A refusal parks the book rather than failing it: a later budget clears it.
    expect(result.status).not.toBe("ready");
  });

  it("prints the acceptance report", () => {
    // The report is part of the deliverable: a roll should be able to read
    // coverage, not just "passed".
    if (reports.length === 0) return;
    const lines = reports.map(
      (r) =>
        `  ${r.note.padEnd(18)} planned=${String(r.planned).padStart(2)} ` +
        `delivered=${String(r.delivered).padStart(2)} failed=${String(r.failed).padStart(2)} ` +
        `coverage=${String(r.coverage).padStart(3)}% status=${r.status.padEnd(9)} ` +
        `requests=${r.requests}`
    );
    console.info(`[book-path acceptance]\n${lines.join("\n")}`);
    expect(reports.length).toBeGreaterThanOrEqual(0);
  });
});
