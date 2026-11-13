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
  UPLOAD_ID_B,
  USER_A,
  USER_B,
  createFakeProvider,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute, query } from "@/lib/turso";
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
  it("pins a new book to direct Fish when Modal is not configured", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    await seedCloneJob("A sentence. ".repeat(300));
    await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    const row = await jobRow(JOB_ID);
    // Never Drama 3: that engine does not speak the clone.
    expect(row?.provider_pin).toBe("fish");
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
    await execute(`UPDATE jobs SET provider_pin = 'fish' WHERE id = ?`, [JOB_ID]);
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls[0]!.cloneProviderPin).toBe("fish");
    expect(fake.calls[0]!.allowFallback).toBe(false);
    expect(fake.calls[0]!.jobId).toBe(JOB_ID);
  });

  it("re-pins a legacy drama3 row to a real engine", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    await seedCloneJob("A sentence. ".repeat(40));
    await execute(`UPDATE jobs SET provider_pin = 'drama3' WHERE id = ?`, [JOB_ID]);
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    // Drama 3 is no longer called. The row is rewritten to direct Fish, which
    // is the account that trained this clone, so it is still the same voice.
    expect((await jobRow(JOB_ID))?.provider_pin).toBe("fish");
    expect(fake.calls.every((call) => call.cloneProviderPin !== "drama3")).toBe(true);
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

  it("continues the same tick on direct Fish once the budget is spent", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    // Fish is the only fallback engine, and it has to be configured to be one.
    process.env.FISH_API_KEY = "test-fish";
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
    // Same voice, different engine: Fish trained this reference.
    expect(row?.provider_pin).toBe("fish");
    const afterSwitch = fake.calls.filter(
      (call) => call.cloneProviderPin === "fish"
    );
    expect(afterSwitch.length).toBe(fake.calls.length);
    expect(fake.calls.every((call) => call.allowFallback === false)).toBe(true);
    delete process.env.FISH_API_KEY;
  });

  it("switches the book and warns once the defer budget is spent", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    process.env.FISH_API_KEY = "test-fish";
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
    expect(row?.provider_pin).toBe("fish");
    expect(String(row?.warning)).toMatch(/same voice/);
    // The rest of the book really does continue on Fish.
    expect(fake.calls.length).toBeGreaterThan(0);
    delete process.env.FISH_API_KEY;
  });

  it("parks without substituting a voice when Fish is not configured", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    delete process.env.FISH_API_KEY;
    delete process.env.FISH_AUDIO_API_KEY;
    vi.stubGlobal("fetch", coldPool());
    await seedCloneJob("A sentence. ".repeat(120));
    process.env.MODAL_S2_DEFER_MS = "60000";
    await execute(
      `UPDATE jobs SET provider_pin = 'modal', clone_wait_started_at = ? WHERE id = ?`,
      [Math.floor(Date.now() / 1000) - 600, JOB_ID]
    );
    const fake = await fakeAdapter();

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    const row = await jobRow(JOB_ID);
    // No second engine and no substitute voice: the book waits, it is not
    // handed to Drama 3 and it is not failed.
    expect(row?.provider_pin).toBe("modal");
    expect(row?.status).toBe("queued");
    expect(result.deferred).toBe(true);
    expect(fake.calls).toEqual([]);
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

/**
 * The 2026-11-06 failure on `job 5f09ee0e`, at the tick level.
 *
 * Every lane answered HTTP 500 (`TypeError: ... metadata_errors`). The book
 * failed with `Section 0: Modal clone already retried` — the retry ledger
 * reported as the cause — and the real provider message was never surfaced.
 * A hard fault must follow the existing defer -> fallback path instead.
 */
describe("Modal hard provider faults", () => {
  /** Every lane answers the container's own 500, never a cold gateway. */
  function faultyPool() {
    return vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") {
        return new Response(
          JSON.stringify({ ready: true, warm_containers: 2, build: "abc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        "TypeError: open() got an unexpected keyword argument 'metadata_errors'",
        { status: 500 }
      );
    });
  }

  it("parks the book instead of failing it on a spent retry", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", faultyPool());
    await seedCloneJob("A sentence. ".repeat(300));

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });

    const row = await jobRow(JOB_ID);
    // Not failed, and not carrying the retry-policy status as its error.
    expect(row?.status).toBe("queued");
    expect(String(row?.error_message ?? "")).not.toMatch(/already retried/);
    // The book keeps its narrator and its cold clock starts, so the drain
    // retries while the deploy is fixed.
    expect(row?.provider_pin).toBe("modal");
    expect(Number(row?.clone_wait_started_at)).toBeGreaterThan(0);
    expect(result.deferred).toBe(true);
  });

  it("records the provider's message where an operator will see it", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", faultyPool());
    await seedCloneJob("A sentence. ".repeat(120));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toMatch(/metadata_errors|provider fault/i);
    expect(logged).not.toMatch(/already retried/);
  });

  it("falls back to the same voice after the defer budget, never to Drama 3", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    process.env.FISH_API_KEY = "test-fish";
    vi.stubGlobal("fetch", faultyPool());
    await seedCloneJob("A sentence. ".repeat(300));
    process.env.MODAL_S2_DEFER_MS = "60000";
    await execute(
      `UPDATE jobs SET provider_pin = 'modal', clone_wait_started_at = ? WHERE id = ?`,
      [Math.floor(Date.now() / 1000) - 600, JOB_ID]
    );

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });

    const row = await jobRow(JOB_ID);
    // Out of patience: the book moves to direct Fish — the same voice — and
    // says so, rather than failing with a retry-ledger status or changing voice.
    expect(row?.provider_pin).toBe("fish");
    expect(String(row?.warning)).toMatch(/same voice/);
    expect(String(row?.error_message ?? "")).not.toMatch(/already retried/);
    delete process.env.FISH_API_KEY;
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
    const vitestFlag = process.env.VITEST;
    delete process.env.VITEST;
    try {
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
    } finally {
      if (vitestFlag === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitestFlag;
    }
  });

  /**
   * The 2026-11-06 Alice smoke (`job db10a6d6`) at the tick level.
   *
   * A 5-section book spent ~4m38s getting to ready from a scaled-to-zero pool,
   * with section 0 — the only section the player can start with — landing at
   * +141s behind lanes for sections 1 and 3, and one lane needing a retry wave.
   */
  describe("first light", () => {
    it("asks the container for section 0 alone before it fans out", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      const seen: number[][] = [];
      const fetchMock = warmPool(4);
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        if (endpointOf(String(url)) === "batch") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          seen.push(
            (Array.isArray(body.items) ? body.items : []).map(
              (item: { key: string }) => Number(item.key)
            )
          );
        }
        return base(url, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      await seedCloneJob("A sentence. ".repeat(900));
      await fakeAdapter();

      const qa = await import("@/lib/tts/transcript-qa");
      const qaSpy = vi.spyOn(qa, "settleSectionTake");
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });

      // The first request carries section 0 with nothing batched beside it.
      expect(seen[0]).toEqual([0]);
      // Section 0 is published before Whisper. The model loads in a fresh
      // process, and that wait used to sit between the GPU and first audio.
      // Later sections are still checked.
      const qaIndexes = qaSpy.mock.calls.map((call) => call[0]?.index);
      expect(qaIndexes).not.toContain(0);
      expect(qaIndexes.length).toBeGreaterThan(0);
      // Section 0 is rendered once. Publishing it re-reads the section cache;
      // it must not buy a second GPU call for the same audio.
      expect(seen.flat().filter((index) => index === 0)).toHaveLength(1);
      // The rest of the tick still fans out afterwards.
      expect(seen.length).toBeGreaterThan(1);
      const segments = JSON.parse(String((await jobRow(JOB_ID))!.segments_json));
      expect(segments[0].status).toBe("ready");
    });

    it("stops after one cold restore when section 0 cannot be placed", async () => {      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      process.env.MODAL_S2_READY = "0";
      process.env.MODAL_S2_COLD_WAIT_MS = "150000";
      const warmSpawn: string[][] = [];
      const { setModalCloneWarmSpawnerForTests } = await import(
        "@/lib/tts/providers/modal-clone-warm"
      );
      setModalCloneWarmSpawnerForTests((command, args) => {
        warmSpawn.push([command, ...args]);
      });
      process.env.MODAL_TOKEN_ID = "test-token";
      const batchCalls: number[][] = [];
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        if (endpointOf(String(url)) === "ready") {
          throw new Error("MODAL_S2_READY=0, no probe");
        }
        const body = JSON.parse(String(init?.body ?? "{}"));
        const keys = (Array.isArray(body.items) ? body.items : []).map(
          (item: { key: string }) => Number(item.key)
        );
        batchCalls.push(keys);
        // The worker drops this wait. The handler would still be rendering.
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      });
      vi.stubGlobal("fetch", fetchMock);
      await seedCloneJob("A sentence. ".repeat(900));
      await fakeAdapter();

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });

      // The worker dropped the HTTP wait. The sync handler keeps rendering
      // section 0, so those sections are not posted again in this dispatch
      // (a second POST would be another container and a second bill).
      // Sections 1..N never open a lane either.
      expect(batchCalls.length).toBe(1);
      for (const keys of batchCalls) expect(keys).toEqual([0]);
      expect(result.deferred).toBe(true);
      // Book keeps its narrator. A first-light timeout holds for the rest
      // of the restore plus the opening section (~106s), not the 400s warm
      // wait, and the row stays processing behind a lease an expired-lease
      // claim will not take.
      const row = await jobRow(JOB_ID);
      expect(row?.provider_pin).toBe("modal");
      expect(Number(row?.clone_wait_started_at ?? 0)).toBeGreaterThan(0);
      const nowSec = Math.floor(Date.now() / 1000);
      const hold = Number(row?.lease_expires_at) - nowSec;
      expect(hold).toBeGreaterThanOrEqual(90);
      expect(hold).toBeLessThanOrEqual(130);
      expect(Number(row?.sched_not_before) - nowSec).toBeGreaterThanOrEqual(90);
      expect(Number(row?.sched_not_before) - nowSec).toBeLessThanOrEqual(130);
      expect(row?.status).toBe("processing");
      expect(row?.processing_lease_token).toBeTruthy();
      const visibleToOldDrain = await query<{ id: string }>(
        `SELECT id FROM jobs WHERE id = ? AND (
           status = 'queued'
           OR (
             status = 'processing'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= unixepoch()
           )
         )`,
        [JOB_ID]
      );
      expect(visibleToOldDrain).toEqual([]);
      const { claimTakehomeLease, cloneParkSeconds } = await import("@/lib/tts/process-job");
      expect(Math.abs(hold - cloneParkSeconds({
        abortedCount: 1,
        firstLightMiss: true,
        warmAbort: false,
        backoffRemainingMs: 0,
      }))).toBeLessThanOrEqual(2);
      expect(await claimTakehomeLease(JOB_ID)).toBeNull();
      // The tick does not start a side cover. The missed placement still
      // kicks one compile off the book path, and the book never awaits it.
      expect(warmSpawn.length).toBeGreaterThanOrEqual(1);
      expect(warmSpawn.every((cmd) => cmd[0] === "modal")).toBe(true);
    });

    it("switches to Fish once repeated timeouts spend the defer budget", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_READY = "0";
      process.env.MODAL_S2_DEFER_MS = "120000";
      process.env.FISH_API_KEY = "test-fish";
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const batchCalls: number[][] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
          if (endpointOf(String(url)) !== "batch") {
            throw new Error("probe is off");
          }
          const body = JSON.parse(String(init?.body ?? "{}"));
          const keys = (Array.isArray(body.items) ? body.items : []).map(
            (item: { key: string }) => Number(item.key)
          );
          batchCalls.push(keys);
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        })
      );
      await seedCloneJob("Hello from the book.");
      await fakeAdapter();
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      for (let tick = 0; tick < 6; tick += 1) {
        const row = await jobRow(JOB_ID);
        if (row?.provider_pin === "fish" || row?.status === "ready") break;
        await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
        // The park is real SQLite time. Clearing it stands in for that
        // hold expiring, while Date.now moves the Fish clock.
        await execute(
          `UPDATE jobs SET sched_not_before = NULL, status = 'queued',
             processing_lease_token = NULL, lease_expires_at = NULL
           WHERE id = ? AND status != 'ready'`,
          [JOB_ID]
        );
        now += 50_000;
      }
      const row = await jobRow(JOB_ID);
      expect(row?.provider_pin).toBe("fish");
      expect(row?.status).toBe("ready");
      expect(batchCalls.length).toBeGreaterThan(0);
      expect(batchCalls.length).toBeLessThanOrEqual(4);
      delete process.env.FISH_API_KEY;
      delete process.env.MODAL_S2_DEFER_MS;
      delete process.env.MODAL_S2_READY;
    });

    it("switches to Fish on one timeout when the clock is already spent", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_READY = "0";
      process.env.FISH_API_KEY = "test-fish";
      const batchCalls: number[][] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
          if (endpointOf(String(url)) !== "batch") throw new Error("probe is off");
          const body = JSON.parse(String(init?.body ?? "{}"));
          batchCalls.push(
            (Array.isArray(body.items) ? body.items : []).map(
              (item: { key: string }) => Number(item.key)
            )
          );
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        })
      );
      await seedCloneJob("Hello from the book.");
      await execute(
        `UPDATE jobs SET clone_wait_started_at = ? WHERE id = ?`,
        [Math.floor(Date.now() / 1000) - 3600, JOB_ID]
      );
      const fake = await fakeAdapter();
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
      const row = await jobRow(JOB_ID);
      expect(row?.provider_pin).toBe("fish");
      expect(batchCalls.length).toBe(1);
      expect(fake.calls.length).toBeGreaterThan(0);
      expect(row?.status).toBe("ready");
      delete process.env.FISH_API_KEY;
      delete process.env.MODAL_S2_READY;
    });

    it("clears the Fish clock when a section publishes", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      vi.stubGlobal("fetch", warmPool(2));
      await seedCloneJob("A sentence. ".repeat(40));
      await execute(
        `UPDATE jobs SET provider_pin = 'modal', clone_wait_started_at = ? WHERE id = ?`,
        [Math.floor(Date.now() / 1000) - 100, JOB_ID]
      );
      await fakeAdapter();
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
      const row = await jobRow(JOB_ID);
      const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
        status?: string;
      }[];
      expect(segments.some((segment) => segment.status === "ready")).toBe(true);
      expect(Number(row?.clone_wait_started_at ?? 0)).toBe(0);
    });

    it("does not charge an attempt for a section whose call was aborted", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      let batches = 0;
      const timedOut: number[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
          if (endpointOf(String(url)) === "ready") {
            return new Response(
              JSON.stringify({ ready: true, warm_containers: 2, build: "abc123" }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          const body = JSON.parse(String(init?.body ?? "{}"));
          const items = Array.isArray(body.items) ? body.items : [];
          const keys = items.map((item: { key: string }) => Number(item.key));
          batches += 1;
          if (batches === 1) {
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
                container_id: "c-1",
                seed: 11,
              }),
              { headers: { "Content-Type": "application/json" } }
            );
          }
          timedOut.push(...keys);
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        })
      );
      await seedCloneJob("A sentence. ".repeat(900));
      await fakeAdapter();
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
      expect(timedOut.length).toBeGreaterThan(0);
      const row = await jobRow(JOB_ID);
      const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
        index: number;
        attempts?: number;
        status?: string;
      }[];
      for (const index of timedOut) {
        const segment = segments.find((row) => row.index === index);
        expect(segment?.attempts ?? 0).toBe(0);
        expect(segment?.status).not.toBe("failed");
      }
      // The call after first audio is a warm call. Its park is the warm
      // HTTP wait. A first-light-sized hold fails this.
      const nowSec = Math.floor(Date.now() / 1000);
      expect(Number(row?.lease_expires_at) - nowSec).toBeGreaterThanOrEqual(390);
    });

    it("parks a cold-pool backoff for the remaining 30s, not the warm wait", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      const batchCalls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (url) => {
          const host = endpointOf(String(url));
          if (host === "batch") batchCalls.push(host);
          if (host === "ready") {
            return new Response(
              JSON.stringify({ ready: false, warm_containers: 0 }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          }
          throw new Error("no synthesize call should be made");
        })
      );
      await seedCloneJob("A sentence for the reader.");
      await fakeAdapter();
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
      const first = await jobRow(JOB_ID);
      expect(first?.status).toBe("queued");
      expect(first?.lease_expires_at ?? null).toBeNull();
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
      const second = await jobRow(JOB_ID);
      const nowSec = Math.floor(Date.now() / 1000);
      const hold = Number(second?.lease_expires_at) - nowSec;
      expect(hold).toBeGreaterThanOrEqual(20);
      expect(hold).toBeLessThan(45);
      expect(batchCalls).toEqual([]);
      expect(second?.provider_pin).toBe("modal");
    });

    it("does not switch to Fish when a published section cleared the clock", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.FISH_API_KEY = "test-fish";
      let batches = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
          if (endpointOf(String(url)) === "ready") {
            return new Response(
              JSON.stringify({ ready: true, warm_containers: 2, build: "abc123" }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          const body = JSON.parse(String(init?.body ?? "{}"));
          const items = Array.isArray(body.items) ? body.items : [];
          batches += 1;
          if (batches === 1) {
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
                container_id: "c-1",
                seed: 11,
              }),
              { headers: { "Content-Type": "application/json" } }
            );
          }
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        })
      );
      await seedCloneJob("A sentence. ".repeat(900));
      await execute(
        `UPDATE jobs SET clone_wait_started_at = ? WHERE id = ?`,
        [Math.floor(Date.now() / 1000) - 3600, JOB_ID]
      );
      await fakeAdapter();
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
      const row = await jobRow(JOB_ID);
      expect(row?.provider_pin).toBe("modal");
      const started = Number(row?.clone_wait_started_at ?? 0);
      expect(started).toBeGreaterThan(Math.floor(Date.now() / 1000) - 120);
      delete process.env.FISH_API_KEY;
    });

    it("does not prewarm a book whose file is still being read", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      const { resetModalCloneWarmForTests } = await import(
        "@/lib/tts/providers/modal-clone-warm"
      );
      resetModalCloneRuntimeForTests();
      resetModalCloneWarmForTests();
      configureModal();
      process.env.MODAL_TOKEN_ID = "test-token";
      await seedCloneJob("One sentence for the reader.");
      await execute(`UPDATE uploads SET status = 'extracting' WHERE id = ?`, [
        UPLOAD_ID_A,
      ]);
      const warmSpawn: string[][] = [];
      const { setModalCloneWarmSpawnerForTests } = await import(
        "@/lib/tts/providers/modal-clone-warm"
      );
      setModalCloneWarmSpawnerForTests((command, args) => {
        warmSpawn.push([command, ...args]);
      });
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
      expect(result.deferred).toBe(true);
      expect(warmSpawn).toHaveLength(0);
    });

    it("does not start a side cover when the only GPU lease is this book's own row", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      const { resetModalCloneWarmForTests } = await import(
        "@/lib/tts/providers/modal-clone-warm"
      );
      resetModalCloneRuntimeForTests();
      resetModalCloneWarmForTests();
      configureModal();
      process.env.MODAL_TOKEN_ID = "test-token";
      process.env.MODAL_S2_MAX_GPUS = "1";
      await seedCloneJob("One sentence for the reader.");
      await execute(
        `INSERT INTO modal_gpu_leases (job_id, user_id, owner_token, created_at, expires_at)
         VALUES (?, ?, 'owner', unixepoch(), unixepoch() + 120)`,
        [JOB_ID, USER_A]
      );
      const warmSpawn: string[][] = [];
      const { setModalCloneWarmSpawnerForTests } = await import(
        "@/lib/tts/providers/modal-clone-warm"
      );
      setModalCloneWarmSpawnerForTests((command, args) => {
        warmSpawn.push([command, ...args]);
      });
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
      expect(warmSpawn).toEqual([]);
    });

    it("keeps one call in flight when first light is off", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_FIRST_LIGHT = "0";
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      // One row per call. A call that returns lets the tick plan the next
      // row, still one HTTP call at a time — not four containers at once.
      process.env.MODAL_S2_BATCH_SIZE = "1";
      // First light is off, but a call that returns still lets the tick plan
      // the next row. One call is in flight at a time — never four H100s.
      try {
        let inflight = 0;
        let maxInflight = 0;
        const rows: number[][] = [];
        const fetchMock = warmPool(4);
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url, init) => {
          if (endpointOf(String(url)) !== "batch") return base(url, init);
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          const body = JSON.parse(String(init?.body ?? "{}"));
          rows.push(
            (Array.isArray(body.items) ? body.items : []).map(
              (item: { key: string }) => Number(item.key)
            )
          );
          try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return await base(url, init);
          } finally {
            inflight -= 1;
          }
        });
        vi.stubGlobal("fetch", fetchMock);
        await seedCloneJob("A sentence. ".repeat(900));
        await fakeAdapter();

        const { processTakehomeTick } = await import("@/lib/tts/process-job");
        await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });

        expect(maxInflight).toBe(1);
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.every((row) => row.length === 1)).toBe(true);
      } finally {
        delete process.env.MODAL_S2_FIRST_LIGHT;
        delete process.env.MODAL_S2_BATCH_SIZE;
      }
    });

    it("sends the whole first wave as one batched call, not one row per lane", async () => {
      // `job db10a6d6` sent 5 sections as four 1-row calls, which run at the
      // 2.9x one-row rate instead of the 35–65x a full batch gets.
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      delete process.env.MODAL_S2_BATCH_SIZE;
      process.env.MODAL_S2_FIRST_LIGHT = "1";
      const rowsPerCall: number[] = [];
      const fetchMock = warmPool(4);
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        if (endpointOf(String(url)) !== "batch") return base(url, init);
        const body = JSON.parse(String(init?.body ?? "{}"));
        rowsPerCall.push(Array.isArray(body.items) ? body.items.length : 0);
        return base(url, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      await seedCloneJob("A sentence. ".repeat(900));
      await fakeAdapter();

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, {});

      // Section 0 alone for first light, then everything else in one call.
      expect(rowsPerCall[0]).toBe(1);
      const fanOut = rowsPerCall.slice(1);
      expect(fanOut.length).toBeGreaterThanOrEqual(1);
      expect(Math.max(...fanOut)).toBeGreaterThan(1);
    });

    it("keeps a 31k book inside the warm budget instead of one cold call", async () => {
      // `job 7e4a8b48`: an 87,000-character cap let one `synthesize_batch`
      // call carry 31k characters, which ran past its wait and never finished.
      // Section 0 stays cold-sized. The call after it may be a full batch,
      // and that batch still has to finish inside the warm wait.
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      delete process.env.MODAL_S2_BATCH_SIZE;
      process.env.MODAL_S2_FIRST_LIGHT = "1";
      const charsPerCall: number[] = [];
      const fetchMock = warmPool(4);
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        if (endpointOf(String(url)) !== "batch") return base(url, init);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const items = Array.isArray(body.items) ? body.items : [];
        charsPerCall.push(
          items.reduce(
            (sum: number, item: { text?: string }) =>
              sum + (item.text ? item.text.length : 0),
            0
          )
        );
        return base(url, init);
      });
      vi.stubGlobal("fetch", fetchMock);
      // A ~31k-character book: the production essay's size.
      await seedCloneJob("A sentence in this essay. ".repeat(1300));
      await fakeAdapter();

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, {});

      const { modalLaneCharCap, modalWarmLaneCharLimit } = await import(
        "@/lib/tts/providers/modal-clone-lanes"
      );
      const { MODAL_CLONE_PROXY_KILL_MS, modalCloneWarmWaitMs } = await import(
        "@/lib/tts/providers/modal-clone-guard"
      );
      const cold = modalLaneCharCap();
      const warm = modalWarmLaneCharLimit();
      // Section 0 is the cold call. The call after it may be a full batch,
      // which is larger than the cold cap, and it still has to finish inside
      // the warm wait. Nothing is one 31k cold call.
      expect(charsPerCall[0]).toBeLessThanOrEqual(cold);
      expect(charsPerCall.length).toBeGreaterThan(1);
      for (const chars of charsPerCall) {
        expect(chars).toBeLessThanOrEqual(warm);
        const packedMs = (chars / 150) * 1000 + 20_000;
        expect(packedMs).toBeLessThanOrEqual(modalCloneWarmWaitMs());
        expect(modalCloneWarmWaitMs()).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
      }
      expect(Math.max(...charsPerCall)).toBeGreaterThan(cold);
    });

    it("re-packs a frozen clone outline that no call could render", async () => {
      // `job 7e4a8b48` was frozen at ~7.7k characters per section. A single row
      // that size needs ~154s of generation, more than the whole placement
      // budget, so lanes, retries and splits all fail on it. The outline has to
      // be replaced before the first section renders.
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      delete process.env.MODAL_S2_BATCH_SIZE;
      process.env.MODAL_S2_FIRST_LIGHT = "1";
      await seedCloneJob("A sentence in this essay. ".repeat(1300));
      await fakeAdapter();
      const { persistFrozenScript } = await import("@/lib/tts/frozen-script");

      // The regression's outline: four 7.7k-character sections.
      const wideText = "word ".repeat(1_540);
      const wide = [0, 1, 2, 3].map((index) => ({
        index,
        text: wideText,
        chapterIndex: 0,
        chapterTitle: null,
        charStart: index * wideText.length,
        charEnd: (index + 1) * wideText.length,
      }));
      await persistFrozenScript(JOB_ID, {
        speakable: wide.map((section) => section.text).join("\n\n"),
        sections: wide,
      });

      const charsPerCall: number[] = [];
      const fetchMock = warmPool(4);
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        if (endpointOf(String(url)) !== "batch") return base(url, init);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const items = Array.isArray(body.items) ? body.items : [];
        charsPerCall.push(
          items.reduce(
            (sum: number, item: { text?: string }) =>
              sum + (item.text ? item.text.length : 0),
            0
          )
        );
        return base(url, init);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, {});

      const { modalCloneSectionChars, modalLaneCharCap, modalWarmLaneCharLimit } =
        await import("@/lib/tts/providers/modal-clone-lanes");
      expect(charsPerCall.length).toBeGreaterThan(0);
      // The 7.7k rows are gone before the GPU sees them. A warm call may then
      // carry more than the cold cap, and still not more than it can finish.
      expect(charsPerCall[0]).toBeLessThanOrEqual(modalLaneCharCap());
      for (const chars of charsPerCall) {
        expect(chars).toBeLessThanOrEqual(modalWarmLaneCharLimit());
      }
      expect(Math.max(...charsPerCall)).toBeLessThanOrEqual(
        modalCloneSectionChars() * 24
      );
      const { loadFrozenScript } = await import("@/lib/tts/frozen-script");
      const frozen = await loadFrozenScript(JOB_ID);
      expect(frozen!.sections.length).toBeGreaterThan(4);
      expect(
        frozen!.sections.every((section) => section.text.length <= modalCloneSectionChars())
      ).toBe(true);
    });

    it("never re-packs a clone book that has already published audio", async () => {
      // Once a section is stored, the outline is the book the person is
      // hearing: changing it would move every published chapter timestamp.
      await seedCloneJob("A sentence in this essay. ".repeat(300));
      await execute(
        `UPDATE jobs SET segments_json = ? WHERE id = ?`,
        [JSON.stringify([{ index: 0, path: "a.mp3", status: "ready" }]), JOB_ID]
      );
      const { persistFrozenScript, loadFrozenScript } = await import(
        "@/lib/tts/frozen-script"
      );
      const wideText = "word ".repeat(1_540);
      await persistFrozenScript(JOB_ID, {
        speakable: wideText,
        sections: [
          {
            index: 0,
            text: wideText,
            chapterIndex: 0,
            chapterTitle: null,
            charStart: 0,
            charEnd: wideText.length,
          },
        ],
      });

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });

      const kept = await loadFrozenScript(JOB_ID);
      expect(kept!.sections[0]!.text.length).toBe(wideText.length);
    });

    it("serializes the first lane so it is section 0 and nothing else", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      let inflight = 0;
      let maxInflightFirstLight = 0;
      const fetchMock = warmPool(4);
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => {
        if (endpointOf(String(url)) !== "batch") return base(url, init);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const keys = (Array.isArray(body.items) ? body.items : []).map(
          (item: { key: string }) => Number(item.key)
        );
        if (keys.length === 1 && keys[0] === 0) {
          maxInflightFirstLight = Math.max(maxInflightFirstLight, inflight);
        }
        inflight += 1;
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return await base(url, init);
        } finally {
          inflight -= 1;
        }
      });
      vi.stubGlobal("fetch", fetchMock);
      await seedCloneJob("A sentence. ".repeat(900));
      await fakeAdapter();

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });

      // Nothing else was in flight when the section-0 call was issued.
      expect(maxInflightFirstLight).toBe(0);
    });
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

describe("staged clone takes are not rendered again", () => {
  // Longer than one 24-section claim, so a tick that sends full batches
  // still leaves a later tick something to render.
  const LONG = "A sentence. ".repeat(12_000);
  /** Every sentence names its place, so two sections cannot share a cache key. */
  const UNIQUE = Array.from({ length: 140 }, (_, index) =>
    `Paragraph ${index} is only this paragraph. `.repeat(30)
  ).join("\n\n");

  function keysOf(body: string | undefined): number[] {
    const parsed = JSON.parse(String(body ?? "{}"));
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items.map((item: { key: string }) => Number(item.key));
  }

  async function readyIndexes(): Promise<number[]> {
    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as Array<{
      index: number;
      status: string;
    }>;
    return segments
      .filter((segment) => segment.status === "ready")
      .map((segment) => segment.index)
      .sort((a, b) => a - b);
  }

  beforeEach(() => {
    process.env.TTS_SECTION_CACHE = "1";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    process.env.TTS_QA_PROVIDER = "off";
    process.env.MODAL_S2_BATCH_SIZE = "24";
    process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
    process.env.MODAL_S2_FIRST_LIGHT = "1";
  });

  afterEach(() => {
    delete process.env.TTS_SECTION_QA_ENABLED;
    delete process.env.TTS_QA_PROVIDER;
    delete process.env.MODAL_S2_BATCH_SIZE;
    delete process.env.MODAL_S2_SECTION_CONCURRENCY;
    delete process.env.MODAL_S2_FIRST_LIGHT;
    delete process.env.CPU_YIELD_SEC;
  });

  it("does not send a staged index on the next tick, including across a restart", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    const seen: number[][] = [];
    let gpu = 0;
    let publishing = 0;
    let overlapped = false;
    let delayMs = 0;
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) !== "batch") return base(url, init);
      seen.push(keysOf(typeof init?.body === "string" ? init.body : undefined));
      gpu += 1;
      if (gpu > 0 && publishing > 0) overlapped = true;
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await base(url, init);
      } finally {
        gpu -= 1;
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const sectionPublish = await import("@/lib/cpu/section-publish");
    const commit = sectionPublish.commitSectionAudio;
    vi.spyOn(sectionPublish, "commitSectionAudio").mockImplementation(async (input) => {
      publishing += 1;
      if (gpu > 0) overlapped = true;
      try {
        return await commit(input);
      } finally {
        publishing -= 1;
      }
    });
    await seedCloneJob(LONG);
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");

    // The next call starts while the previous call's audio is publishing,
    // so a slow render overlaps that publish inside the same tick.
    delayMs = 40;
    await processTakehomeTick(JOB_ID, {});
    const first = seen.flat();
    expect(first.length).toBeGreaterThan(8);
    expect(overlapped).toBe(true);
    const ready = await readyIndexes();
    expect(ready[0]).toBe(0);
    for (let i = 0; i < ready.length; i++) expect(ready[i]).toBe(i);
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.length).toBeLessThanOrEqual(new Set(first).size);

    delayMs = 0;
    overlapped = false;
    const mark = seen.length;
    await processTakehomeTick(JOB_ID, {});
    const second = seen.slice(mark).flat();
    const again = second.filter((index) => first.includes(index));
    expect(again).toEqual([]);
    expect(second.length).toBeGreaterThan(0);
    const readyAfter = await readyIndexes();
    for (let i = 0; i < readyAfter.length; i++) expect(readyAfter[i]).toBe(i);
    expect(readyAfter.length).toBeGreaterThan(ready.length);
  }, 60_000);

  it("keeps a staged take across a CPU yield and publishes a late master without rendering it", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    process.env.CPU_YIELD_SEC = "1";
    const seen: number[][] = [];
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) === "batch") {
        seen.push(keysOf(typeof init?.body === "string" ? init.body : undefined));
      }
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const sectionPublish = await import("@/lib/cpu/section-publish");
    const { uploadFile } = await import("@/lib/storage");
    vi.spyOn(sectionPublish, "commitSectionAudio").mockImplementation(async (input) => {
      const uploaded = await uploadFile(
        `audiobooks/${input.jobId}`,
        `raw/${String(input.index).padStart(4, "0")}.${input.extension}`,
        input.audio,
        input.contentType
      );
      return {
        ready: false,
        path: "",
        rawPath: uploaded.path,
        contentType: input.contentType,
        mastered: false,
      };
    });
    await seedCloneJob(LONG);
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const first = await processTakehomeTick(JOB_ID, {});
    expect(first.yieldSlot).toBe(true);
    const rendered = new Set(seen.flat());
    expect(rendered.size).toBeGreaterThan(1);

    await execute(
      `UPDATE jobs SET sched_not_before = NULL, status = 'queued' WHERE id = ?`,
      [JOB_ID]
    );
    const mark = seen.length;
    await processTakehomeTick(JOB_ID, {});
    const second = seen.slice(mark).flat();
    expect(second.filter((index) => rendered.has(index))).toEqual([]);
    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as Array<{
      index: number;
      status: string;
    }>;
    const head = segments.find((segment) => segment.index === 0);
    expect(head?.status).toBe("ready");
    expect(second).not.toContain(0);
    expect(row?.status).not.toBe("failed");
  }, 60_000);

  it("refuses a cache entry for a different voice and a silent take", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    const seen: number[][] = [];
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) === "batch") {
        seen.push(keysOf(typeof init?.body === "string" ? init.body : undefined));
      }
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob(UNIQUE);
    await fakeAdapter();
    const { processTakehomeTick, takehomeSectionCacheKey } = await import(
      "@/lib/tts/process-job"
    );
    const { fishSpeedForRequest, initialNarrationSpeed } = await import(
      "@/lib/tts/narration-pace"
    );
    const { deleteFile } = await import("@/lib/storage");
    const { writeSectionCache } = await import("@/lib/tts/section-cache");
    const { loadFrozenScript } = await import("@/lib/tts/frozen-script");
    const { emptyWav } = await import("@/test/harness");

    await processTakehomeTick(JOB_ID, {});
    const ready = await readyIndexes();
    expect(ready.length).toBeGreaterThanOrEqual(3);
    // The ramp publishes what it renders. Drop three ready sections back to
    // unclaimed so the next tick has to trust the cache, which is the
    // restart case this test is about.
    const staged = ready.slice(0, 3);
    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as Array<{
      index: number;
      path?: string;
      rawPath?: string;
    }>;
    await execute(`UPDATE jobs SET segments_json = ? WHERE id = ?`, [
      JSON.stringify(segments.filter((segment) => !staged.includes(segment.index))),
      JOB_ID,
    ]);
    const frozen = await loadFrozenScript(JOB_ID);
    expect(frozen).toBeTruthy();
    const speed = fishSpeedForRequest(
      initialNarrationSpeed({ catalogVoiceId: CLONE_ID, text: frozen!.speakable })
    );
    const { fileExists } = await import("@/lib/storage");
    const keyFor = (index: number, voice: string) =>
      takehomeSectionCacheKey({
        text: frozen!.sections[index]!.text,
        voiceId: voice,
        model: "s2.1-pro-base",
        index,
        speed,
        providerId: "openrouter",
        catalogVoiceId: CLONE_ID,
      });
    const cachedStaged: number[] = [];
    for (const index of staged) {
      if (await fileExists(`tts-cache/${keyFor(index, "clone-ref")}.mp3`)) {
        cachedStaged.push(index);
      }
    }
    expect(cachedStaged.length).toBeGreaterThanOrEqual(3);
    const [victim, silent, keeper] = cachedStaged;
    await deleteFile(`tts-cache/${keyFor(victim!, "clone-ref")}.mp3`);
    await writeSectionCache(keyFor(victim!, "other-voice"), "mp3", fakeMp3(), "audio/mpeg");
    await writeSectionCache(keyFor(silent!, "clone-ref"), "mp3", emptyWav(), "audio/wav");
    // Raw audio would be recovered as a finished take and the cache would
    // never be consulted. Drop it for the two indexes whose cache is bad.
    const stored = new Map(segments.map((segment) => [segment.index, segment]));
    for (const index of [victim!, silent!]) {
      const pad = String(index).padStart(4, "0");
      const segment = stored.get(index);
      for (const storagePath of [
        segment?.rawPath,
        segment?.path,
        `audiobooks/${JOB_ID}/raw/${pad}.mp3`,
        `audiobooks/${JOB_ID}/raw/${pad}.wav`,
        `audiobooks/${JOB_ID}/sections/${pad}.mp3`,
      ]) {
        if (storagePath && (await fileExists(storagePath))) {
          await deleteFile(storagePath);
        }
      }
    }
    await execute(
      `DELETE FROM cpu_tasks WHERE job_id = ? AND section_index IN (?, ?)`,
      [JOB_ID, victim!, silent!]
    );

    const mark = seen.length;
    await processTakehomeTick(JOB_ID, {});
    const second = new Set(seen.slice(mark).flat());
    expect(second.has(victim!)).toBe(true);
    expect(second.has(silent!)).toBe(true);
    expect(second.has(keeper!)).toBe(false);
  }, 60_000);

  it("retries a failed row without repeating the rows that were staged beside it", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    const seen: number[][] = [];
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) !== "batch") return base(url, init);
      const keys = keysOf(typeof init?.body === "string" ? init.body : undefined);
      seen.push(keys);
      const response = await base(url, init);
      const payload = await response.json();
      payload.items = payload.items.map((item: { key: string }) =>
        item.key === "5"
          ? { key: item.key, error: "row failed", error_code: "row" }
          : item
      );
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob(UNIQUE);
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, {});
    const first = seen.flat();
    expect(first).toContain(5);
    const staged = first.filter((index) => index !== 5);

    const mark = seen.length;
    await processTakehomeTick(JOB_ID, {});
    const second = seen.slice(mark).flat();
    expect(second).toContain(5);
    expect(second.filter((index) => staged.includes(index))).toEqual([]);
  }, 60_000);

  it("does not repeat rows from a call that finished when a later call drops", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    let batches = 0;
    const seen: number[][] = [];
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) !== "batch") return base(url, init);
      const keys = keysOf(typeof init?.body === "string" ? init.body : undefined);
      seen.push(keys);
      batches += 1;
      // Section 0 returns. The fat call after it drops. The next tick retries
      // that call's rows and does not buy section 0 again.
      if (batches > 1) throw new TypeError("socket hang up");
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob(UNIQUE);
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, {});
    const staged = seen[0] ?? [];
    const dropped = seen[1] ?? [];
    expect(staged.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);

    const mark = seen.length;
    await processTakehomeTick(JOB_ID, {});
    const second = seen.slice(mark).flat();
    expect(second.filter((index) => staged.includes(index))).toEqual([]);
    expect(second.some((index) => dropped.includes(index))).toBe(true);
  }, 60_000);

  it("does not put a cached index on a busy lane, and a held lease sends nothing", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    let busy = false;
    const seen: number[][] = [];
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) !== "batch") return base(url, init);
      const keys = keysOf(typeof init?.body === "string" ? init.body : undefined);
      seen.push(keys);
      if (busy) return new Response("lane busy", { status: 429 });
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob(UNIQUE);
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, {});
    const staged = new Set(seen.flat());
    busy = true;
    const mark = seen.length;
    const duringBusy = await processTakehomeTick(JOB_ID, {});
    const requested = seen.slice(mark).flat();
    expect(requested.filter((index) => staged.has(index))).toEqual([]);
    const busyRow = await jobRow(JOB_ID);
    expect(busyRow?.error_message ?? busyRow?.status).not.toBe("failed");
    expect(busyRow?.status).not.toBe("failed");
    expect(duringBusy.done).toBe(false);

    const calls = seen.length;
    await execute(
      `UPDATE jobs SET status = 'processing', processing_lease_token = 'held-by-other',
         lease_expires_at = unixepoch() + 600 WHERE id = ?`,
      [JOB_ID]
    );
    const blocked = await processTakehomeTick(JOB_ID, {});
    expect(blocked.busy).toBe(true);
    expect(seen.length).toBe(calls);
  }, 60_000);
});

describe("a book-wave miss does not open more GPU calls", () => {
  it("posts one batch when the container answers 429", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    let batchPosts = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") {
        return new Response(
          JSON.stringify({ ready: true, warm_containers: 1, build: "abc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      batchPosts += 1;
      return new Response("lane busy", { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob("A sentence in this essay. ".repeat(400));
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 8 });
    expect(batchPosts).toBe(1);
    expect(result.yieldSlot).toBe(true);
    const row = await jobRow(JOB_ID);
    expect(row?.status).not.toBe("failed");
  });

  it("records a dropped row as a retry so the next take changes seed", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    const epochs: number[] = [];
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) !== "batch") return base(url, init);
      const body = JSON.parse(String(init?.body ?? "{}"));
      epochs.push(Number(body.seed_epoch) || 0);
      const response = await base(url, init);
      const payload = await response.json();
      payload.items = (payload.items as { key: string }[]).map((item) =>
        item.key === "0"
          ? { key: item.key, error: "row failed", error_code: "row" }
          : item
      );
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob("A short sentence. ".repeat(80));
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, {});
    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as {
      index: number;
      status: string;
      attempts?: number;
    }[];
    const dropped = segments.find((segment) => segment.index === 0);
    expect(dropped?.status).toBe("retry");
    expect(dropped?.attempts).toBe(1);
    await processTakehomeTick(JOB_ID, {});
    expect(epochs.length).toBeGreaterThan(1);
    expect(epochs.at(-1)).toBeGreaterThan(epochs[0] ?? 0);
  });
});

describe("a parked provider fault does not fail the book on a later tick", () => {
  function faultyPool() {
    return vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") {
        return new Response(
          JSON.stringify({ ready: true, warm_containers: 2, build: "abc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("TypeError: metadata_errors", { status: 500 });
    });
  }

  it("keeps the row queued and never reports a spent retry", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    vi.stubGlobal("fetch", faultyPool());
    await seedCloneJob("A sentence. ".repeat(600));

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    for (let tick = 0; tick < 3; tick += 1) {
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 2 });
      const row = await jobRow(JOB_ID);
      // Still Modal (the deploy may be fixed) and never failed on the ledger.
      expect(row?.provider_pin).toBe("modal");
      expect(row?.status).toBe("queued");
      expect(String(row?.error_message ?? "")).not.toMatch(/already retried/);
      await execute(`UPDATE jobs SET status = 'queued' WHERE id = ?`, [JOB_ID]);
    }
  });
});

describe("clone books get their own GPU until the ceiling", () => {
  const OTHER_ID = "eeeeeeee-0000-4000-8000-000000000002";

  it("keeps this book's ramp when another clone book still fits", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
    let posts = 0;
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) === "batch") posts += 1;
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob("A sentence in this essay. ".repeat(80));
    const otherPath = await seedUpload({
      id: UPLOAD_ID_B,
      userId: USER_B,
      text: "Another sentence in the other essay. ".repeat(80),
    });
    await seedJob({
      id: OTHER_ID,
      userId: USER_B,
      pdfStoragePath: otherPath,
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
    });
    await execute(`UPDATE jobs SET created_at = 10 WHERE id = ?`, [JOB_ID]);
    await execute(`UPDATE jobs SET created_at = 20, status = 'queued' WHERE id = ?`, [OTHER_ID]);
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
    expect(posts).toBeGreaterThan(0);
    expect(result.yieldSlot).not.toBe(true);
  });

  it("queues a younger book when the GPU ceiling is already full", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    const { acquireModalGpuLease } = await import("@/lib/tts/providers/modal-gpu-lease");
    resetModalCloneRuntimeForTests();
    configureModal();
    process.env.MODAL_S2_MAX_GPUS = "1";
    process.env.MODAL_S2_MAX_GPUS_PER_USER = "5";
    let posts = 0;
    const fetchMock = warmPool(4);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (endpointOf(String(url)) === "batch") posts += 1;
      return base(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await seedCloneJob("A sentence in this essay. ".repeat(80));
    const otherPath = await seedUpload({
      id: UPLOAD_ID_B,
      userId: USER_B,
      text: "Another sentence in the other essay. ".repeat(80),
    });
    await seedJob({
      id: OTHER_ID,
      userId: USER_B,
      pdfStoragePath: otherPath,
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
    });
    await execute(`UPDATE jobs SET created_at = 30 WHERE id = ?`, [JOB_ID]);
    await execute(`UPDATE jobs SET created_at = 5, status = 'queued' WHERE id = ?`, [OTHER_ID]);
    expect(
      (
        await acquireModalGpuLease({
          jobId: "holder-book",
          userId: "user-holder",
          ownerToken: "holder-token",
          createdAt: 1,
          ttlSeconds: 90,
          globalCap: 1,
          perUserCap: 5,
        })
      ).ok
    ).toBe(true);
    await fakeAdapter();
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });
    expect(posts).toBe(0);
    expect(result.yieldSlot).toBe(true);
    delete process.env.MODAL_S2_MAX_GPUS;
    delete process.env.MODAL_S2_MAX_GPUS_PER_USER;
  });
});
