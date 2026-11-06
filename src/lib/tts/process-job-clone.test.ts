/**
 * Worker behaviour for the self-hosted clone path.
 *
 * The book is asynchronous, so "the GPU pool has nothing warm" must not become
 * "different narrator from section 7". These tests drive the real tick against
 * the in-memory database and a faked *HTTP* endpoint, so the lane dispatch,
 * the readiness probe and the defer policy all run for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  BATCH_HOST,
  READY_HOST,
  endpointOf,
} from "@/lib/tts/providers/modal-endpoints.fixture";

const JOB_ID = "dddddddd-0000-4000-8000-000000000001";
const CLONE_ID = "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeeffff";

async function seedCloneJob(text: string) {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text,
  });
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
  await seedCloneVoice();
}

/** A stored clone row + its sample object, so `loadCloneReference` succeeds. */
async function seedCloneVoice() {
  const { uploadFile } = await import("@/lib/storage");
  const samplePath = "clones/saved/sample.wav";
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
    [CLONE_ID.slice("clone:".length), USER_A, "clone-ref", "Test Clone", samplePath]
  );
}

/** Modal is configured, and the ready probe is answered by the fake fetch. */
function configureModal() {
  // Each Modal endpoint is its own host; there is no base to append to.
  process.env.MODAL_S2_TTS_URL = BATCH_HOST;
  process.env.MODAL_S2_READY_URL = READY_HOST;
  process.env.MODAL_S2_TOKEN = "test-token";
}

function coldPool() {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (endpointOf(String(url)) === "ready") {
      return new Response(
        JSON.stringify({ ready: false, warm_containers: 0, build: "abc123" }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error("the pool is cold; no synthesize call should be made");
  });
}

function warmPool(sections: number) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (endpointOf(String(url)) === "ready") {
      return new Response(
        JSON.stringify({ ready: true, warm_containers: 2, build: "abc123" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const items = Array.isArray(body.items) ? body.items : [];
    return new Response(
      JSON.stringify({
        items: items.map((item: { key: string; text: string }) => ({
          key: item.key,
          audio_b64: Buffer.from(fakeMp3(2048, 3)).toString("base64"),
          duration_s: (item.text.length / 900) * 60,
          units: 2,
          truncated_units: 0,
        })),
        build: "abc123",
        container_id: `c-${sections}`,
        seed: 11,
        performance: { generate_s: 4, sections: items.length },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  process.env.TTS_SECTIONS_PER_TICK = "2";
  delete process.env.TTS_TAKEHOME_FANOUT;
  delete process.env.MODAL_S2_SECTION_CONCURRENCY;
  delete process.env.MODAL_S2_DEFER_MS;
  delete process.env.CLONE_TTS_PROVIDER;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.MODAL_S2_TOKEN;
  delete process.env.TTS_SECTION_CACHE;
});

async function fakeAdapter() {
  const providers = await import("@/lib/tts/providers");
  const fake = createFakeProvider();
  vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
  return fake;
}

describe("clone provider pinning", () => {
  it("pins a new book to the fallback engine when Modal is not configured", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    await seedCloneJob("A sentence. ".repeat(300));
    await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    const row = await jobRow(JOB_ID);
    expect(row?.provider_pin).toBe("drama3");
  });

  it("does not overwrite a pin that is already on the row", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    await seedCloneJob("A sentence. ".repeat(40));
    await execute(`UPDATE jobs SET provider_pin = 'fish' WHERE id = ?`, [JOB_ID]);
    await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    // A book stored as `fish` keeps its engine: changing it would change the
    // narrator mid-book, which is exactly what the pin exists to prevent.
    expect((await jobRow(JOB_ID))?.provider_pin).toBe("fish");
  });

  it("passes the pin and disables per-call fallback for a pinned book", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    await seedCloneJob("A sentence. ".repeat(40));
    await execute(`UPDATE jobs SET provider_pin = 'drama3' WHERE id = ?`, [JOB_ID]);
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls[0]!.cloneProviderPin).toBe("drama3");
    expect(fake.calls[0]!.allowFallback).toBe(false);
    expect(fake.calls[0]!.jobId).toBe(JOB_ID);
  });
});

describe("cold GPU pool parks the book", () => {
  it("releases the lease and leaves the row queued, with no attempts burned", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", coldPool());
    await seedCloneJob("A sentence. ".repeat(300));
    await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });

    expect(result.deferred).toBe(true);
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("queued");
    expect(row?.processing_lease_token).toBeNull();
    expect(row?.provider_pin).toBe("modal");
    // A cold pool must not mark sections failed or store a hole.
    const segments = row?.segments_json ? JSON.parse(String(row.segments_json)) : [];
    expect(segments).toEqual([]);
  });

  it("does not probe or synthesize while the cold backoff is active", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    const fetchMock = coldPool();
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob("A sentence. ".repeat(300));
    await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
    const readyCalls = fetchMock.mock.calls.filter((call) =>
      endpointOf(String(call[0])) === "ready"
    ).length;
    expect(readyCalls).toBeGreaterThan(0);

    // Second tick inside the 30s backoff: another probe would be wasted work.
    await execute(`UPDATE jobs SET status = 'queued' WHERE id = ?`, [JOB_ID]);
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
    const after = fetchMock.mock.calls.filter((call) =>
      endpointOf(String(call[0])) === "ready"
    ).length;
    expect(after).toBe(readyCalls);
  });

  it("starts the defer clock once and keeps counting on later ticks", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", coldPool());
    await seedCloneJob("A sentence. ".repeat(300));
    await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
    const first = Number((await jobRow(JOB_ID))?.clone_wait_started_at);
    expect(first).toBeGreaterThan(0);

    // A later tick must not reset the clock, or the book would wait forever.
    await execute(
      `UPDATE jobs SET status = 'queued', updated_at = unixepoch() WHERE id = ?`,
      [JOB_ID]
    );
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
    expect(Number((await jobRow(JOB_ID))?.clone_wait_started_at)).toBe(first);
  });

  it("continues the same tick on the fallback engine once the budget is spent", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", coldPool());
    // A book with several sections, so one tick has work after the switch.
    await seedCloneJob("A sentence. ".repeat(900));
    process.env.MODAL_S2_DEFER_MS = "60000";
    await execute(
      `UPDATE jobs SET provider_pin = 'modal', clone_wait_started_at = ? WHERE id = ?`,
      [Math.floor(Date.now() / 1000) - 600, JOB_ID]
    );
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });

    const row = await jobRow(JOB_ID);
    expect(row?.provider_pin).toBe("drama3");
    // Every section rendered by this same tick must use the engine the row now
    // says, not keep calling a pool the book has already given up on.
    const afterSwitch = fake.calls.filter(
      (call) => call.cloneProviderPin === "drama3"
    );
    expect(afterSwitch.length).toBe(fake.calls.length);
    expect(fake.calls.every((call) => call.allowFallback === false)).toBe(true);
  });

  it("switches the book and warns once the defer budget is spent", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", coldPool());
    await seedCloneJob("A sentence. ".repeat(120));
    process.env.MODAL_S2_DEFER_MS = "60000";
    await execute(
      `UPDATE jobs SET provider_pin = 'modal', clone_wait_started_at = ? WHERE id = ?`,
      [Math.floor(Date.now() / 1000) - 600, JOB_ID]
    );
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    const row = await jobRow(JOB_ID);
    expect(row?.provider_pin).toBe("drama3");
    expect(String(row?.warning)).toMatch(/backup narrator/);
    // The rest of the book really does continue on the fallback engine.
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("does not park at all when deferral is switched off", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", coldPool());
    await seedCloneJob("A sentence. ".repeat(120));
    process.env.MODAL_S2_DEFER_MS = "0";
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    // Rollback path: the old fail-fast behaviour, one tick and out.
    expect(fake.calls.length).toBeGreaterThan(0);
  });
});

describe("lane staging", () => {
  it("stages rendered sections under index-stable object names", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    const fetchMock = warmPool(2);
    vi.stubGlobal("fetch", fetchMock);
    process.env.TTS_SECTION_CACHE = "1";
    delete process.env.VITEST;
    await seedCloneJob("A sentence. ".repeat(300));
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    expect(
      fetchMock.mock.calls.some((call) => endpointOf(String(call[0])) === "batch")
    ).toBe(true);

    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row!.segments_json));
    expect(Array.isArray(segments)).toBe(true);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.path).toContain(
        `sections/${String(segment.index).padStart(4, "0")}.`
      );
    }
    // The lanes filled the sections, so the slower per-section path either had
    // nothing left to do or only handled a tail.
    expect(fake.calls.length).toBeLessThanOrEqual(1);
  });

  it("sends one batch call per lane, with the pinned job id", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    process.env.MODAL_S2_SECTION_CONCURRENCY = "2";
    const fetchMock = warmPool(2);
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob("A sentence. ".repeat(900));
    await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });

    const batchCalls = fetchMock.mock.calls.filter((call) =>
      endpointOf(String(call[0])) === "batch"
    );
    expect(batchCalls.length).toBeGreaterThan(0);
    for (const call of batchCalls) {
      const body = JSON.parse(String(call[1]!.body));
      expect(body.job_id).toBe(JOB_ID);
      expect(body.reference_text).toBeTruthy();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.seed_epoch).toBe(0);
    }
  });

  it("a second worker on the same job cannot take the lease or clobber it", async () => {
    await seedCloneJob("A sentence. ".repeat(40));
    const { claimTakehomeLease } = await import("@/lib/tts/process-job");

    const first = await claimTakehomeLease(JOB_ID);
    const second = await claimTakehomeLease(JOB_ID);
    expect(first).toBeTruthy();
    expect(second).toBeNull();

    const stale = await execute(
      `UPDATE jobs SET progress = 99
       WHERE id = ? AND processing_lease_token = ?`,
      [JOB_ID, "not-the-token"]
    );
    expect(stale.rowsAffected).toBe(0);
  });
});
