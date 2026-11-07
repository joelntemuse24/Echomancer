/**
 * Shared permits for the generation paths that used to bypass the cap.
 * Two OS processes share a file database. No provider HTTP, no customer audio.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  createFakeProvider,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute, query } from "@/lib/turso";
import {
  beginTakehomeCreate,
  commitTakehomeCreate,
  releaseTakehomeCreateForJob,
} from "@/lib/jobs/takehome-identity";
import { deleteJob } from "@/lib/turso/jobs";
import {
  ProviderSlotBusyError,
  readProviderThrottle,
  releaseProviderSlot,
  tryAcquireProviderSlot,
  writeProviderThrottle,
  type SlotSql,
} from "@/lib/tts/provider-slots";
import { beginLiveFish } from "@/lib/tts/fish-slots";
import { noteEdgeGoogleThrottle, resetEdgeGoogleThrottle } from "@/lib/tts/section-concurrency";
import {
  resetModalCloneRuntimeForTests,
  synthesizeModalClone,
  synthesizeModalClonePreview,
} from "@/lib/tts/providers/modal-clone";
import { setModalCloneWarmSpawnerForTests } from "@/lib/tts/providers/modal-clone-warm";
import { startFishHttpStream } from "@/lib/tts/providers/fish";
import { ffmpegCpuCap, tryCpuSlot } from "@/lib/cpu/task-slot";

const appDb: SlotSql = {
  execute: (sql, args) => execute(sql, args),
  queryOne: async () => null,
};

const tsx = path.join(process.cwd(), "node_modules/.bin/tsx");
const childScript = path.join(process.cwd(), "src/lib/jobs/capacity-child.ts");

function runChild(args: string[], url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tsx, [childScript, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, TURSO_DATABASE_URL: url, VITEST: "1" },
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child ${code}: ${err || out}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

afterEach(() => {
  resetEdgeGoogleThrottle();
  resetModalCloneRuntimeForTests();
  setModalCloneWarmSpawnerForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generation permits", () => {
  it("refuses a per-section Modal call before any fetch when the lanes are full", async () => {
    await resetDatabase();
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "1");
    vi.stubEnv("MODAL_S2_WARM_HOOK", "0");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const held = await tryAcquireProviderSlot(appDb, {
      provider: "modal-clone",
      cap: 1,
      ownerToken: "other-worker",
      ttlSeconds: 90,
    });
    expect(held).toBe(0);
    await expect(
      synthesizeModalClone({
        text: "One quiet sentence.",
        voiceId: "private",
        catalogVoiceId: "clone:saved",
      })
    ).rejects.toBeInstanceOf(ProviderSlotBusyError);
    expect(fetchMock).not.toHaveBeenCalled();
    await releaseProviderSlot(appDb, {
      provider: "modal-clone",
      slotId: 0,
      ownerToken: "other-worker",
    });
  });

  it("does not fall a full Modal lane through to Fish", async () => {
    await resetDatabase();
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_S2_TTS_URL", "https://example.invalid");
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "1");
    vi.stubEnv("MODAL_S2_WARM_HOOK", "0");
    vi.stubEnv("FISH_API_KEY", "test-fish");
    vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await tryAcquireProviderSlot(appDb, {
      provider: "modal-clone",
      cap: 1,
      ownerToken: "other-worker",
      ttlSeconds: 90,
    });
    await expect(
      startFishHttpStream({
        text: "One quiet sentence.",
        voiceId: "private",
        catalogVoiceId: "clone:saved",
        allowFallback: true,
      })
    ).rejects.toBeInstanceOf(ProviderSlotBusyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds the preview lane only after the pool is warm", async () => {
    await resetDatabase();
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_S2_TTS_URL", "https://batch.example");
    vi.stubEnv("MODAL_S2_READY_URL", "https://ready.example");
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "1");
    vi.stubEnv("MODAL_S2_WARM_HOOK", "0");
    setModalCloneWarmSpawnerForTests(() => {});
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ready: true, warm_containers: 1, build: "abc" }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    await tryAcquireProviderSlot(appDb, {
      provider: "modal-clone",
      cap: 1,
      ownerToken: "other-worker",
      ttlSeconds: 90,
    });
    await expect(
      synthesizeModalClonePreview({
        text: "One quiet sentence.",
        voiceId: "private",
        catalogVoiceId: "clone:saved",
      })
    ).rejects.toBeInstanceOf(ProviderSlotBusyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops the sixth live Fish request and lets it in after a release", async () => {
    await resetDatabase();
    const ends: Array<() => Promise<void>> = [];
    for (let i = 0; i < 5; i++) ends.push(await beginLiveFish());
    await expect(beginLiveFish()).rejects.toBeInstanceOf(ProviderSlotBusyError);
    await ends[0]!();
    const again = await beginLiveFish();
    await again();
    await Promise.all(ends.slice(1).map((end) => end()));
  });

  it("returns a Paradee book to the queue without speaking when the cap is full", async () => {
    await resetDatabase();
    const pdfPath = await seedUpload({
      id: "abababab-abab-4aba-8aba-abababababab",
      userId: USER_A,
      text: "Chapter 1.\n\nThe harbor was quiet after the rain.",
    });
    await seedJob({
      id: "job-paradee-cap",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "paradee",
      catalogVoiceId: "echomancer-andrew",
      providerVoiceId: "andrew",
    });
    await tryAcquireProviderSlot(appDb, {
      provider: "paradee",
      cap: 1,
      ownerToken: "other-worker",
      ttlSeconds: 90,
    });
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider(async () => {
      throw new Error("should not synthesize");
    });
    fake.id = "paradee";
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    process.env.TTS_PARADEE_FANOUT = "1";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    try {
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      const result = await processTakehomeTick("job-paradee-cap", {
        sectionsPerTick: 2,
        deadlineMs: Date.now() + 120_000,
      });
      expect(result.deferred).toBe(true);
      expect(fake.calls.length).toBe(0);
      const row = await jobRow("job-paradee-cap");
      expect(row?.status).toBe("queued");
    } finally {
      delete process.env.TTS_PARADEE_FANOUT;
      delete process.env.TTS_SECTION_QA_ENABLED;
    }
  });

  it("uses the shared Edge 429 cap even when this process has not seen a 429", async () => {
    await resetDatabase();
    await writeProviderThrottle("edge", 1, 120);
    expect(await readProviderThrottle("edge")).toBe(1);
    const pdfPath = await seedUpload({
      id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      userId: USER_A,
      text: "Chapter 1.\n\nThe harbor was quiet after the rain.",
    });
    await seedJob({
      id: "job-edge-throttle",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "edge",
      catalogVoiceId: "standard",
      providerVoiceId: "en-US-AndrewNeural",
    });
    await tryAcquireProviderSlot(appDb, {
      provider: "edge",
      cap: 1,
      ownerToken: "other-worker",
      ttlSeconds: 90,
    });
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider(async () => {
      throw new Error("should not synthesize");
    });
    fake.id = "edge";
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "8";
    process.env.TTS_SECTION_QA_ENABLED = "0";
    try {
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      const result = await processTakehomeTick("job-edge-throttle", {
        sectionsPerTick: 4,
        deadlineMs: Date.now() + 120_000,
      });
      expect(result.deferred).toBe(true);
      expect(fake.calls.length).toBe(0);
    } finally {
      delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
      delete process.env.TTS_SECTION_QA_ENABLED;
    }
  });

  it("publishes the halved Edge cap for other processes", async () => {
    await resetDatabase();
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "8";
    noteEdgeGoogleThrottle();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await readProviderThrottle("edge")).toBe(4);
    delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
  });

  it("refuses a live stream while the voice cap is full and leaves the job queued", async () => {
    await resetDatabase();
    const pdfPath = await seedUpload({
      id: "efefefef-efef-4fef-8fef-efefefefefef",
      userId: USER_A,
      text: "The harbor was quiet after the rain.",
    });
    await seedJob({
      id: "job-stream-cap",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      jobKind: "stream",
      ttsProvider: "edge",
      catalogVoiceId: "standard",
      providerVoiceId: "en-US-AndrewNeural",
    });
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "1";
    await tryAcquireProviderSlot(appDb, {
      provider: "edge",
      cap: 1,
      ownerToken: "other-worker",
      ttlSeconds: 90,
    });
    const { createStreamAudioIterator } = await import("@/lib/tts/stream-session");
    await expect(createStreamAudioIterator("job-stream-cap")).rejects.toBeInstanceOf(
      ProviderSlotBusyError
    );
    const row = await jobRow("job-stream-cap");
    expect(row?.status).toBe("queued");
    delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
  });

  it("frees the create key on delete and keeps a retried book as the same row", async () => {
    await resetDatabase();
    const pdfPath = await seedUpload({
      id: "01010101-0101-4101-8101-010101010101",
      userId: USER_A,
      text: "The harbor was quiet.",
    });
    const input = {
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "edge",
      catalogVoiceId: "standard",
      providerVoiceId: "en-US-AndrewNeural",
    };
    const first = await beginTakehomeCreate({ ...input, jobId: "job-delete-me" });
    expect(first.action).toBe("insert");
    await seedJob({
      id: "job-delete-me",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      ttsProvider: "edge",
      catalogVoiceId: "standard",
      providerVoiceId: "en-US-AndrewNeural",
    });
    if (first.action === "insert") await commitTakehomeCreate(first.idemKey, first.jobId);
    await execute(
      `UPDATE jobs SET status = 'failed', error_message = 'no' WHERE id = 'job-delete-me'`
    );
    await execute(
      `UPDATE jobs SET status = 'queued', error_message = NULL WHERE id = 'job-delete-me'`
    );
    const retried = await beginTakehomeCreate({ ...input, jobId: "job-should-not-exist" });
    expect(retried).toMatchObject({ action: "use", jobId: "job-delete-me" });
    await deleteJob("job-delete-me");
    await releaseTakehomeCreateForJob("job-delete-me");
    const again = await beginTakehomeCreate({ ...input, jobId: "job-after-delete" });
    expect(again.action).toBe("insert");
    const rows = await query<{ id: string }>(
      `SELECT id FROM jobs WHERE deleted_at IS NULL AND pdf_storage_path = ?`,
      [pdfPath]
    );
    expect(rows).toEqual([]);
  });

  it("shares the ffmpeg ceiling and gives the permit back on release", async () => {
    await resetDatabase();
    const cap = ffmpegCpuCap();
    const held = [];
    for (let i = 0; i < cap; i++) {
      const slot = await tryCpuSlot("ffmpeg", 0);
      expect(slot).not.toBeNull();
      expect(slot).not.toBe("unavailable");
      held.push(slot);
    }
    expect(await tryCpuSlot("ffmpeg", 0)).toBeNull();
    const first = held[0];
    if (first && first !== "unavailable") await first.release();
    const again = await tryCpuSlot("ffmpeg", 0);
    expect(again).not.toBeNull();
    if (again && again !== "unavailable") await again.release();
    await Promise.all(
      held.slice(1).map((slot) =>
        slot && slot !== "unavailable" ? slot.release() : Promise.resolve()
      )
    );
  });
});

describe("two processes", () => {
  it("lets only one process take the last lane", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "echo-proc-"));
    const url = `file:${path.join(dir, "cap.db")}`;
    await runChild(["migrate", url], url);
    const [left, right] = await Promise.all([
      runChild(["slot", url, "proc-a", "modal-clone", "1"], url),
      runChild(["slot", url, "proc-b", "modal-clone", "1"], url),
    ]);
    const slots = [left, right].map((line) => {
      const parsed = JSON.parse(line.split("\n").at(-1) || "{}") as { slot: number | null };
      return parsed.slot;
    });
    expect(slots.filter((slot) => slot === 0)).toHaveLength(1);
    expect(slots.filter((slot) => slot === null)).toHaveLength(1);
  }, 60_000);

  it("inserts one take-home when two processes create the same book", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "echo-proc-"));
    const url = `file:${path.join(dir, "create.db")}`;
    await runChild(["migrate", url], url);
    const [left, right] = await Promise.all([
      runChild(["create", url, "job-proc-a"], url),
      runChild(["create", url, "job-proc-b"], url),
    ]);
    const parsed = [left, right].map((line) => JSON.parse(line.split("\n").at(-1) || "{}") as {
      action?: string;
      error?: string;
    });
    const inserts = parsed.filter((row) => row.action === "insert");
    expect(inserts, JSON.stringify(parsed)).toHaveLength(1);
    const other = parsed.find((row) => row.action !== "insert");
    expect(
      other?.action === "use" || other?.error === "TakehomeCreateBusyError",
      JSON.stringify(parsed)
    ).toBe(true);
  }, 60_000);
});
