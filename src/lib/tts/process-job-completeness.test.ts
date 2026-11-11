/**
 * The book orchestration path, end to end, with a completeness contract.
 *
 * `job 75944dc9` is the case this file exists for. It reported `ready` after
 * 32 s with **5 of 11** sections, and the five that existed were reused cache
 * entries from older builds. Three defects hid each other:
 *
 *   1. the budget gate refused the book and every section reported it as a
 *      provider failure, so the diagnosis pointed at Modal;
 *   2. the cache key did not include the narration recipe, so pre-fix audio was
 *      served inside a post-fix book;
 *   3. assembly accepted "more than half ready", so the result was published as
 *      a finished audiobook.
 *
 * These tests drive the real tick against the in-memory database and a faked
 * HTTP endpoint. Only the speech provider and the network are fake; the gate,
 * the lane dispatch, the per-section path, the cache and the publish decision
 * all run.
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
import { takehomeSectionCacheKey } from "@/lib/tts/process-job";
import { writeSectionCache } from "@/lib/tts/section-cache";

const JOB_ID = "75944dc9-deb4-4591-98f9-ff5c4fcd5e73";
const CLONE_ID = "clone:e552d5a5-8f2f-484d-9399-800ddacba85c";

/** Every POST body the tick sent, so coverage of the source text is assertable. */
const postedTexts: string[] = [];

type Call = { host: string; method: string };

function recordFetch(respond: (call: Call, body: unknown) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = endpointOf(String(input));
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ host, method });
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (method === "POST" && body && Array.isArray(body.items)) {
        for (const item of body.items) postedTexts.push(String(item.text ?? ""));
      }
      return respond({ host, method }, body);
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

/**
 * Warm pool that only renders the sections it is told to.
 *
 * Everything else comes back as a row error, which is a real provider answer
 * (`{key, error, error_code}`) and therefore exercises the per-section failure
 * path rather than a network fault.
 */
function poolRenderingOnly(allowed: (index: number) => boolean) {
  return recordFetch((call, body) => {
    if (call.host === "ready") {
      return new Response(
        JSON.stringify({ ready: true, warm_containers: 2, build: "aa02126d8267" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    const items = (body as { items?: { key: string; text: string }[] })?.items ?? [];
    return new Response(
      JSON.stringify({
        items: items.map((item) => {
          if (!allowed(Number(item.key))) {
            return {
              key: item.key,
              error: "section has no speakable text",
              error_code: "empty_text",
            };
          }
          return {
            key: item.key,
            audio_b64: Buffer.from(fakeMp3(4096, Number(item.key) + 1)).toString("base64"),
            // Duration must scale with the text: `cloneTakeIsTruncated`
            // rejects a take under half the 900-chars/minute expectation, so a
            // flat 40 s would fail every ~2,000-character section.
            duration_s: (item.text.length / 900) * 60,
            units: 3,
            truncated_units: 0,
          };
        }),
        build: "aa02126d8267",
        container_id: "c1",
        seed: 7,
        performance: { generate_s: 5, sections: items.length },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
}

function warmPool() {
  return recordFetch((call, body) => {
    if (call.host === "ready") {
      return new Response(
        JSON.stringify({ ready: true, warm_containers: 2, build: "aa02126d8267" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    const items = (body as { items?: { key: string; text: string }[] })?.items ?? [];
    return new Response(
      JSON.stringify({
        items: items.map((item) => ({
          key: item.key,
          audio_b64: Buffer.from(fakeMp3(4096, 3)).toString("base64"),
          duration_s: (item.text.length / 900) * 60,
          units: 3,
          truncated_units: 0,
        })),
        build: "aa02126d8267",
        container_id: "c1",
        seed: 7,
        performance: { generate_s: 5, sections: items.length },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
}

/** ~17k characters in 32 paragraphs, the shape of the real book. */
function vdhSource(): string {
  const sentence =
    "But they do use brilliantly the landscape of contemporary eighteenth-century " +
    "agriculture to demonstrate how the natural bounty of America molded the European " +
    "religious and political heritage into something far more dynamic. ";
  // Each paragraph is distinct, including the repeated openers. The section
  // cache is keyed on the text, so a later section with the same words is one
  // take, not a second request. A unique token in each paragraph keeps this fixture from
  // collapsing onto that key and measuring the ledger instead of coverage.
  const openers = [
    "The argument began with soil.",
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
    (_, i) => `${openers[i % openers.length]} uniq${i}token ${sentence.repeat(4)}`
  ).join("\n\n");
}

beforeEach(async () => {
  vi.restoreAllMocks();
  postedTexts.length = 0;
  await resetDatabase();
  process.env.TTS_SECTIONS_PER_TICK = "4";
  process.env.TTS_RETRY_BACKOFF_MS = "0";
  delete process.env.TTS_TAKEHOME_FANOUT;
  delete process.env.MODAL_S2_SECTION_CONCURRENCY;
  delete process.env.MODAL_S2_DEFER_MS;
  delete process.env.CLONE_TTS_PROVIDER;
  delete process.env.MODAL_S2_USER_DAILY_CHARS;
  delete process.env.MODAL_S2_GLOBAL_DAILY_CHARS;
  // Production has the section cache ON. The harness turns it off for tests
  // unless it is asked for, which meant the clone **lane staging** path (which
  // writes a rendered section, then lets the per-section path publish it) was
  // never exercised by any test. `job 75944dc9` was a cache-interaction bug, so
  // this file runs with the cache exactly as production does.
  process.env.TTS_SECTION_CACHE = "1";
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
  ]) {
    delete process.env[key];
  }
});

describe("every source character is planned and delivered", () => {
  it("sends the whole book's text to the provider across its sections", async () => {
    configureModal();
    warmPool();
    const source = vdhSource();
    await seedCloneJob(source);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    for (let tick = 0; tick < 12; tick += 1) {
      const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
      if (result.done) break;
    }

    const row = await jobRow(JOB_ID);
    const total = Number(row?.total_sections ?? 0);
    expect(total).toBeGreaterThan(1);

    // Nothing may be dropped between the frozen sections and the wire. Compare
    // on collapsed whitespace, because packing normalises paragraph breaks.
    const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
    const planned = JSON.parse(String(row?.segments_json ?? "[]")) as {
      status: string;
      error?: string;
    }[];
    expect(planned).toHaveLength(total);
    expect(planned.map((segment) => segment.error).filter(Boolean)).toEqual([]);
    expect(planned.every((segment) => segment.status === "ready")).toBe(true);

    const sent = normalise(postedTexts.join(" "));
    const wanted = normalise(source);
    // Every word of the source was requested at least once, and no request
    // invented text: compare as multisets of words.
    const countWords = (text: string) => {
      const map = new Map<string, number>();
      for (const word of normalise(text).toLowerCase().split(" ")) {
        if (!word) continue;
        map.set(word, (map.get(word) ?? 0) + 1);
      }
      return map;
    };
    const sentWords = countWords(sent);
    for (const [word, count] of countWords(wanted)) {
      expect(sentWords.get(word) ?? 0, `missing "${word}"`).toBeGreaterThanOrEqual(count);
    }
    expect(row?.status).toBe("ready");
  });
});

describe("a failed section is never presented as a complete book", () => {
  it("marks the job failed with the exact shortfall while keeping the audio", async () => {
    configureModal();
    // Only section 0 renders. The rest fail at the provider, so the book ends
    // with one section of seventeen — a smaller version of the production shape
    // (5 of 11) and the case that must not be published as complete.
    poolRenderingOnly((index) => index === 0);
    // Failures are permanent decisions here, not a cold pool to wait out, so the
    // tick must not park on the defer clock before it can assemble.
    process.env.MODAL_S2_DEFER_MS = "0";
    await seedCloneJob(vdhSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    // A dropped row spends the section attempt budget (3) before it is
    // failed, and this tick only claims four indexes. 18 sections need
    // more than 12 of those ticks.
    for (let tick = 0; tick < 24; tick += 1) {
      const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
      if (result.done) break;
    }

    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
      status: string;
    }[];
    const ready = segments.filter((segment) => segment.status === "ready").length;
    const total = Number(row?.total_sections ?? 0);
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThan(total);

    // Not "ready with a warning": a book missing sections is not the book.
    // One count: how many sections were narrated. Not a second "only N exist".
    expect(row?.status).toBe("failed");
    expect(String(row?.error_message)).toContain(`${ready} of ${total}`);
    expect(String(row?.error_message)).not.toContain(`${total - ready} of ${total}`);
    expect(String(row?.error_message)).toMatch(/not a complete audiobook/i);
    expect(String(row?.error_message)).not.toMatch(/\bModal\b|Section\s+0:/i);
    // The sections that exist are still stored and still playable.
    expect(segments.some((segment) => segment.status === "ready")).toBe(true);
    // Progress is not 100% on an incomplete book.
    expect(Number(row?.progress ?? 0)).toBeLessThan(100);
  });
});

describe("cache hits and provider failures on the same book", () => {
  it("reuses only takes recorded under the current recipe", async () => {
    configureModal();
    // Nothing renders: every row is a provider error. That freezes the outline
    // and leaves every section unready, which is the state a retry sees.
    poolRenderingOnly(() => false);
    process.env.MODAL_S2_DEFER_MS = "0";
    await seedCloneJob(vdhSource());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { processTakehomeTick, takehomeCacheVariant } = await import(
      "@/lib/tts/process-job"
    );
    const { loadFrozenSectionOutline } = await import("@/lib/tts/frozen-script");
    const { sectionCacheKey } = await import("@/lib/tts/section-cache");

    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    const outline = await loadFrozenSectionOutline(JOB_ID);
    expect(outline).not.toBeNull();
    expect(outline!.length).toBeGreaterThan(1);
    const target = outline![1]!;

    // Plant a take under the PRE-#246 variant: engine name plus a hand-bumped
    // version, which is exactly what production served for five of eleven
    // sections while the new 560-character runtime rendered nothing.
    expect(takehomeCacheVariant("fish", CLONE_ID)).not.toBe("s2-pro-modal-v1");
    const oldKey = sectionCacheKey({
      text: target.text,
      voiceId: "clone-ref",
      model: "s2.1-pro-base",
      latency: "normal",
      speed: undefined,
      chunkLength: 300,
      variant: "s2-pro-modal-v1",
    });
    const currentKey = takehomeSectionCacheKey({
      text: target.text,
      voiceId: "clone-ref",
      model: "s2.1-pro-base",
      index: target.index,
      providerId: "fish",
      catalogVoiceId: CLONE_ID,
    });
    // The two keys must be different objects, or the old audio is served.
    expect(currentKey).not.toBe(oldKey);

    // Write the legacy object at the legacy key.
    await writeSectionCache(oldKey, "mp3", fakeMp3(1111, 9), "audio/mpeg");

    // Now render for real. The provider must be asked for that section: an
    // entry recorded under an older recipe is not this book's audio.
    postedTexts.length = 0;
    vi.unstubAllGlobals();
    warmPool();
    const row0 = await jobRow(JOB_ID);
    await execute(
      `UPDATE jobs SET provider_pin = 'modal', segments_json = '[]',
         next_section_index = 0 WHERE id = ?`,
      [JOB_ID]
    ).catch(() => undefined);
    expect(row0).toBeDefined();

    for (let tick = 0; tick < 12; tick += 1) {
      const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 8 });
      if (result.done) break;
    }
    expect(postedTexts.length).toBeGreaterThan(0);
    // The section whose old-recipe take was planted must have been requested.
    const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
    const sent = postedTexts.map(normalise).join(" ");
    expect(sent).toContain(normalise(target.text).slice(0, 60));
  });
});
