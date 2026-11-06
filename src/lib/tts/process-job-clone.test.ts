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

  it("falls back after the defer budget instead of failing the book", async () => {
    const { resetModalCloneRuntimeForTests } = await import(
      "@/lib/tts/providers/modal-clone"
    );
    resetModalCloneRuntimeForTests();
    configureModal();
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
    // Out of patience: the book switches to the documented fallback and says
    // so, rather than failing with a retry-ledger status.
    expect(row?.provider_pin).toBe("drama3");
    expect(String(row?.warning)).toMatch(/backup narrator/);
    expect(String(row?.error_message ?? "")).not.toMatch(/already retried/);
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

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });

      // The first request carries section 0 with nothing batched beside it.
      expect(seen[0]).toEqual([0]);
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
        // Both attempts at section 0 miss the restore budget.
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      });
      vi.stubGlobal("fetch", fetchMock);
      await seedCloneJob("A sentence. ".repeat(900));
      await fakeAdapter();

      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      const result = await processTakehomeTick(JOB_ID, { sectionsPerTick: 4 });

      // Section 0 and its one retry. Sections 1..N never open a lane: on a pool
      // that could not restore one call, four calls are four more failures.
      expect(batchCalls.length).toBe(2);
      for (const keys of batchCalls) expect(keys).toEqual([0]);
      expect(result.deferred).toBe(true);
      // Book keeps its narrator and the compile is finished off this path.
      const row = await jobRow(JOB_ID);
      expect(row?.provider_pin).toBe("modal");
      // One pre-warm from the tick starting, one from the missed placement.
      // Both are the same cheap RPC and the book never awaits either.
      expect(warmSpawn.length).toBeGreaterThanOrEqual(1);
      expect(warmSpawn.every((cmd) => cmd[0] === "modal")).toBe(true);
    });

    it("falls back to the old all-lanes wave when MODAL_S2_FIRST_LIGHT=0", async () => {
      const { resetModalCloneRuntimeForTests } = await import(
        "@/lib/tts/providers/modal-clone"
      );
      resetModalCloneRuntimeForTests();
      configureModal();
      process.env.MODAL_S2_FIRST_LIGHT = "0";
      process.env.MODAL_S2_SECTION_CONCURRENCY = "4";
      // Batch of 1 makes the fan-out observable: with the old wave all four
      // rows open at once, which is exactly the shape first light removes.
      process.env.MODAL_S2_BATCH_SIZE = "1";
      try {
        // Count how many batch calls are in flight when each one starts.
        let inflight = 0;
        let maxInflight = 0;
        const fetchMock = warmPool(4);
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url, init) => {
          if (endpointOf(String(url)) !== "batch") return base(url, init);
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
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

        // Rollback path: no serialized section-0 call ahead of the fan-out.
        expect(maxInflight).toBeGreaterThan(1);
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
