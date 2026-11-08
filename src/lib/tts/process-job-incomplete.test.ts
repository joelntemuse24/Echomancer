/**
 * The production shape, scaled to the same counts: 113 ready sections,
 * 180 failed masters that still have a raw path, and a concat row left
 * `queued` with attempts already spent and `finished_at` set. One tick
 * must fail the book, leave the ready paths alone, and not POST.
 */

import { createServer, type Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  createFakeProvider,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";
import { uploadFile } from "@/lib/storage";
import { persistFrozenScript } from "@/lib/tts/frozen-script";
import { enqueueCpuTask, getCpuTask } from "@/lib/cpu/tasks";
import { MASTERING_UNFINISHED_MESSAGE } from "@/lib/modal/workspace-disabled";
import { resetModalWorkspaceDisabled } from "@/lib/modal/workspace-disabled";

const JOB_ID = "7c1bcf22-1883-40c3-b7e9-4699e256c430";
const READY = 113;
const FAILED = 180;
const TOTAL = READY + FAILED;

function listen(): Promise<{ server: Server; url: string; posts: () => number }> {
  let posts = 0;
  const server = createServer((_req, res) => {
    posts += 1;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("workspace ac-disabledtest is disabled.");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/`, posts: () => posts });
    });
  });
}

beforeEach(async () => {
  resetModalWorkspaceDisabled();
  vi.restoreAllMocks();
  await resetDatabase();
  delete process.env.CPU_RUNNER;
  delete process.env.MODAL_CPU_URL;
});

describe("an incomplete book with raw takes is not concatenated", () => {
  it("fails 113 ready / 180 raw-failed without accepting a 404 or looping concat", async () => {
    const text = "A sentence that stays on disk and is not spoken again.";
    const pdfPath = await seedUpload({ id: UPLOAD_ID_A, userId: USER_A, text });
    const sections = Array.from({ length: TOTAL }, (_, index) => ({
      index,
      text: `Section ${index}. A unique sentence ${index} stays frozen.`,
      chapterIndex: 0,
      chapterTitle: null,
      charStart: index * 40,
      charEnd: index * 40 + 20,
    }));
    await persistFrozenScript(JOB_ID, {
      speakable: sections.map((section) => section.text).join("\n\n"),
      sections,
    });
    const readyPath = `audiobooks/${JOB_ID}/sections/0000.mp3`;
    const readyBytes = Buffer.from("ready-section-bytes");
    await uploadFile(`audiobooks/${JOB_ID}/sections`, "0000.mp3", readyBytes, "audio/mpeg");
    const segments = Array.from({ length: TOTAL }, (_, index) =>
      index < READY
        ? {
            index,
            status: "ready" as const,
            path: index === 0 ? readyPath : `audiobooks/${JOB_ID}/sections/${String(index).padStart(4, "0")}.mp3`,
          }
        : {
            index,
            status: "failed" as const,
            path: "",
            rawPath: `audiobooks/${JOB_ID}/raw/${String(index).padStart(4, "0")}.mp3`,
            error: "cpu lease expired",
          }
    );
    await seedJob({
      id: JOB_ID,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      segments,
      totalSections: TOTAL,
      ttsProvider: "openrouter",
      providerVoiceId: "Achernar",
    });
    await execute(
      `UPDATE jobs SET progress = 39, current_section = ?, warning = ? WHERE id = ?`,
      [
        READY,
        "Your cloned voice took too long to start on the fast engine, so the rest of this book was made with the same voice on the backup engine.",
        JOB_ID,
      ]
    );
    await enqueueCpuTask({
      id: `concat:${JOB_ID}`,
      kind: "concat",
      jobId: JOB_ID,
      inputPath: `audiobooks/${JOB_ID}`,
      outputPath: `audiobooks/${JOB_ID}/full.mp3`,
    });
    await execute(
      `UPDATE cpu_tasks SET status = 'queued', attempts = 3, finished_at = 1794116698,
         started_at = NULL, error_message = NULL WHERE id = ?`,
      [`concat:${JOB_ID}`]
    );
    const providers = await import("@/lib/tts/providers");
    const fake = createFakeProvider();
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const live = await listen();
    process.env.CPU_RUNNER = "modal";
    process.env.MODAL_CPU_URL = live.url;
    process.env.TTS_SECTION_QA_ENABLED = "0";
    try {
      const { processTakehomeTick } = await import("@/lib/tts/process-job");
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 8 });
      const row = await jobRow(JOB_ID);
      expect(row?.status).toBe("failed");
      expect(row?.status).not.toBe("ready");
      expect(String(row?.error_message)).toBe(MASTERING_UNFINISHED_MESSAGE);
      expect(String(row?.error_message)).not.toMatch(/could not be narrated/i);
      expect(Number(row?.progress)).toBeLessThan(100);
      expect(row?.provider_pin ?? null).toBeNull();
      expect(row?.audio_storage_path ?? null).toBeNull();
      expect(row?.warning ?? null).toBeNull();
      const stored = JSON.parse(String(row?.segments_json)) as Array<{
        index: number;
        status: string;
        path?: string;
      }>;
      expect(stored.filter((segment) => segment.status === "ready")).toHaveLength(READY);
      expect(stored.find((segment) => segment.index === 0)?.path).toBe(readyPath);
      expect(stored.filter((segment) => segment.status === "failed")).toHaveLength(FAILED);
      expect(fake.calls).toHaveLength(0);
      expect(live.posts()).toBe(0);
      const concat = await getCpuTask(`concat:${JOB_ID}`);
      expect(Number(concat?.attempts)).toBe(3);
      expect(Number(concat?.finished_at)).toBe(1794116698);
      expect(concat?.status === "queued" || concat?.status === "failed").toBe(true);
      await processTakehomeTick(JOB_ID, { sectionsPerTick: 8 });
      expect((await jobRow(JOB_ID))?.status).toBe("failed");
      expect(live.posts()).toBe(0);
      expect(fake.calls).toHaveLength(0);
    } finally {
      live.server.closeAllConnections?.();
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
      delete process.env.CPU_RUNNER;
      delete process.env.MODAL_CPU_URL;
      delete process.env.TTS_SECTION_QA_ENABLED;
    }
  });
});
