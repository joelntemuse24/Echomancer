/**
 * A clone book that only has CPU work left must not start a GPU restore.
 * Concat, saved raw, an exhausted concat retry, a fish pin, and a full
 * cache hit are the cases. A new book with nothing cached still may.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  createFakeProvider,
  fakeMp3,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";
import { uploadFile } from "@/lib/storage";
import { persistFrozenScript } from "@/lib/tts/frozen-script";
import { enqueueCpuTask } from "@/lib/cpu/tasks";
import { writeSectionCache } from "@/lib/tts/section-cache";
import { takehomeSectionCacheKey } from "@/lib/tts/process-job";
import { fishSpeedForRequest, DEFAULT_NARRATION_SPEED } from "@/lib/tts/narration-pace";
import { resetModalCloneRuntimeForTests } from "@/lib/tts/providers/modal-clone";
import {
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "@/lib/tts/providers/modal-clone-warm";
import { BATCH_HOST, READY_HOST } from "@/lib/tts/providers/modal-endpoints.fixture";

const JOB_ID = "c0c0c0c0-0000-4000-8000-0000000000c0";
const CLONE_ID = "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeeffff";

let gpuCalls: string[][];

function armGpuWatch() {
  gpuCalls = [];
  resetModalCloneRuntimeForTests();
  resetModalCloneWarmForTests();
  setModalCloneWarmSpawnerForTests((command, args) => {
    gpuCalls.push([command, ...args]);
  });
  process.env.MODAL_S2_TTS_URL = BATCH_HOST;
  process.env.MODAL_S2_READY_URL = READY_HOST;
  process.env.MODAL_S2_TOKEN = "test-token";
  process.env.MODAL_TOKEN_ID = "test-token";
  process.env.TTS_SECTION_QA_ENABLED = "0";
  delete process.env.CLONE_TTS_PROVIDER;
  delete process.env.CPU_RUNNER;
  delete process.env.MODAL_CPU_URL;
}

async function seedClone(text: string) {
  const pdfPath = await seedUpload({ id: UPLOAD_ID_A, userId: USER_A, text });
  await uploadFile(
    "clones/saved",
    "sample.wav",
    Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(28), Buffer.from("WAVE"), Buffer.alloc(64)]),
    "audio/wav"
  );
  await execute(
    `INSERT OR REPLACE INTO cloned_voices
       (id, user_id, fish_voice_id, title, sample_storage_path, state, model)
     VALUES (?, ?, ?, ?, ?, 'trained', 's2.1-pro-base')`,
    [CLONE_ID.slice("clone:".length), USER_A, "clone-ref", "VDH", "clones/saved/sample.wav"]
  );
  return pdfPath;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  armGpuWatch();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("modal.run")) {
        throw new Error("no Modal GPU request on a CPU-only tick");
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setModalCloneWarmSpawnerForTests(null);
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.MODAL_S2_READY_URL;
  delete process.env.MODAL_S2_TOKEN;
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.TTS_SECTION_QA_ENABLED;
  delete process.env.TTS_SECTION_CACHE;
});

describe("CPU-only clone ticks do not start a GPU", () => {
  it("does not warm when the book is already concatenated", async () => {
    const pdfPath = await seedClone("Already joined.");
    const text = "Section zero stays ready.";
    await persistFrozenScript(JOB_ID, {
      speakable: text,
      sections: [
        {
          index: 0,
          text,
          chapterIndex: 0,
          chapterTitle: null,
          charStart: 0,
          charEnd: text.length,
        },
      ],
    });
    await uploadFile(`audiobooks/${JOB_ID}/sections`, "0000.mp3", fakeMp3(), "audio/mpeg");
    await uploadFile(`audiobooks/${JOB_ID}`, "full.mp3", fakeMp3(4096), "audio/mpeg");
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
      totalSections: 1,
      segments: [
        {
          index: 0,
          status: "ready",
          path: `audiobooks/${JOB_ID}/sections/0000.mp3`,
        },
      ],
    });
    await execute(`UPDATE jobs SET provider_pin = 'modal' WHERE id = ?`, [JOB_ID]);
    await enqueueCpuTask({
      id: `concat:${JOB_ID}`,
      kind: "concat",
      jobId: JOB_ID,
      inputPath: `audiobooks/${JOB_ID}`,
      outputPath: `audiobooks/${JOB_ID}/full.mp3`,
    });
    await execute(`UPDATE cpu_tasks SET status = 'done', attempts = 1 WHERE id = ?`, [
      `concat:${JOB_ID}`,
    ]);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    expect(gpuCalls).toEqual([]);
  });

  it("does not warm when the only hole is saved raw", async () => {
    const pdfPath = await seedClone("Raw already spoken.");
    const text = "The raw take is kept.";
    await persistFrozenScript(JOB_ID, {
      speakable: text,
      sections: [
        {
          index: 0,
          text,
          chapterIndex: 0,
          chapterTitle: null,
          charStart: 0,
          charEnd: text.length,
        },
      ],
    });
    await uploadFile(`audiobooks/${JOB_ID}/raw`, "0000.mp3", fakeMp3(), "audio/mpeg");
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
      totalSections: 1,
      segments: [
        {
          index: 0,
          status: "failed",
          path: "",
          rawPath: `audiobooks/${JOB_ID}/raw/0000.mp3`,
          error: "cpu lease expired",
        },
      ],
    });
    await execute(`UPDATE jobs SET provider_pin = 'modal' WHERE id = ?`, [JOB_ID]);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    expect(gpuCalls).toEqual([]);
  });

  it("does not warm when concat retries are already spent", async () => {
    const pdfPath = await seedClone("Concat already tried.");
    const text = "Ready section.";
    await persistFrozenScript(JOB_ID, {
      speakable: text,
      sections: [
        {
          index: 0,
          text,
          chapterIndex: 0,
          chapterTitle: null,
          charStart: 0,
          charEnd: text.length,
        },
      ],
    });
    await uploadFile(`audiobooks/${JOB_ID}/sections`, "0000.mp3", fakeMp3(), "audio/mpeg");
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
      totalSections: 1,
      segments: [
        {
          index: 0,
          status: "ready",
          path: `audiobooks/${JOB_ID}/sections/0000.mp3`,
        },
      ],
    });
    await execute(`UPDATE jobs SET provider_pin = 'modal' WHERE id = ?`, [JOB_ID]);
    await enqueueCpuTask({
      id: `concat:${JOB_ID}`,
      kind: "concat",
      jobId: JOB_ID,
      inputPath: `audiobooks/${JOB_ID}`,
      outputPath: `audiobooks/${JOB_ID}/full.mp3`,
    });
    await execute(
      `UPDATE cpu_tasks SET status = 'queued', attempts = 3, finished_at = 1794116698,
         started_at = NULL WHERE id = ?`,
      [`concat:${JOB_ID}`]
    );
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    expect(gpuCalls).toEqual([]);
  });

  it("does not warm a fish-pinned book that still has words to speak", async () => {
    const pdfPath = await seedClone("Fallback engine. ".repeat(30));
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
    });
    await execute(`UPDATE jobs SET provider_pin = 'fish' WHERE id = ?`, [JOB_ID]);
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider();
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    expect(gpuCalls).toEqual([]);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("does not warm when every claimable section is already cached", async () => {
    const text = "This take is already in the section cache.";
    const pdfPath = await seedClone(text);
    await persistFrozenScript(JOB_ID, {
      speakable: text,
      sections: [
        {
          index: 0,
          text,
          chapterIndex: 0,
          chapterTitle: null,
          charStart: 0,
          charEnd: text.length,
        },
      ],
    });
    process.env.TTS_SECTION_CACHE = "1";
    const key = takehomeSectionCacheKey({
      text,
      voiceId: "clone-ref",
      model: "s2.1-pro-base",
      index: 0,
      speed: fishSpeedForRequest(DEFAULT_NARRATION_SPEED),
      providerId: "fish",
      catalogVoiceId: CLONE_ID,
    });
    await writeSectionCache(key, "mp3", fakeMp3(2048), "audio/mpeg");
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
      ttsOptions: { narrationSpeed: DEFAULT_NARRATION_SPEED },
      totalSections: 1,
    });
    await execute(`UPDATE jobs SET provider_pin = 'modal' WHERE id = ?`, [JOB_ID]);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 });
    expect(gpuCalls).toEqual([]);
  });

  it("still pre-warms a narration retry even when a cached take exists", async () => {
    const text = "Speak this section again.";
    const pdfPath = await seedClone(text);
    await persistFrozenScript(JOB_ID, {
      speakable: text,
      sections: [
        {
          index: 0,
          text,
          chapterIndex: 0,
          chapterTitle: null,
          charStart: 0,
          charEnd: text.length,
        },
      ],
    });
    process.env.TTS_SECTION_CACHE = "1";
    const key = takehomeSectionCacheKey({
      text,
      voiceId: "clone-ref",
      model: "s2.1-pro-base",
      index: 0,
      speed: fishSpeedForRequest(DEFAULT_NARRATION_SPEED),
      providerId: "fish",
      catalogVoiceId: CLONE_ID,
    });
    await writeSectionCache(key, "mp3", fakeMp3(2048), "audio/mpeg");
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
      ttsOptions: { narrationSpeed: DEFAULT_NARRATION_SPEED },
      totalSections: 1,
      segments: [{ index: 0, status: "retry", path: "", error: "qa miss" }],
    });
    await execute(`UPDATE jobs SET provider_pin = 'modal' WHERE id = ?`, [JOB_ID]);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 }).catch(() => undefined);
    expect(gpuCalls.length).toBeGreaterThan(0);
  });

  it("still pre-warms a new book that has no cached take", async () => {
    const pdfPath = await seedClone("A sentence that has not been spoken.");
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      catalogVoiceId: CLONE_ID,
      ttsProvider: "fish",
      providerVoiceId: "clone-ref",
      model: "s2.1-pro-base",
    });
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, { sectionsPerTick: 1 }).catch(() => undefined);
    expect(gpuCalls.length).toBeGreaterThan(0);
    expect(
      gpuCalls.every(
        (cmd) => cmd[0] === "modal" && cmd.includes("modal/s2_clone_warm.py::cover")
      )
    ).toBe(true);
  });
});
