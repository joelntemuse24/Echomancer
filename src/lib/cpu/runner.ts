/**
 * Runs one CPU task on this process, or asks the Modal CPU app to run it.
 *
 * `CPU_RUNNER=local` (the default, including tests) claims the row and
 * executes here, bounded by this host's CPU permits. `CPU_RUNNER=modal`
 * POSTs the task id to `MODAL_CPU_URL`. The container claims the same
 * row, reads and writes object storage, and does not share this
 * process's temp directory. A 429 leaves the task queued.
 */

import { CpuSaturatedError } from "@/lib/cpu/errors";
import {
  CPU_TASK_LEASE_SECONDS,
  cancelCpuTask,
  claimCpuTask,
  completeCpuTask,
  failCpuTask,
  getCpuTask,
  heartbeatCpuTask,
  requeueCpuTask,
  type CpuTaskKind,
  type CpuTaskRow,
} from "@/lib/cpu/tasks";
import { runInsideCpuTask, tryCpuSlot, type LocalCpuKind } from "@/lib/cpu/task-slot";
import { downloadFile, fileExists, uploadFile } from "@/lib/storage";
import { queryOne } from "@/lib/turso";
import { masterSectionBuffer } from "@/lib/tts/section-master";
import { checkTranscriptAlignment, transcribeLocally } from "@/lib/tts/transcript-qa";

export type CpuRunResult = "done" | "deferred" | "failed" | "lost" | "cancelled";

export function cpuRunner(): "local" | "modal" {
  return process.env.CPU_RUNNER === "modal" ? "modal" : "local";
}

function slotKind(kind: CpuTaskKind): LocalCpuKind {
  if (kind === "whisper") return "whisper";
  if (kind === "extract") return "extract";
  return "ffmpeg";
}

function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function splitKey(storagePath: string): { directory: string; filename: string } {
  const index = storagePath.lastIndexOf("/");
  if (index <= 0) return { directory: ".", filename: storagePath };
  return {
    directory: storagePath.slice(0, index),
    filename: storagePath.slice(index + 1),
  };
}

async function jobStopped(jobId: string | null): Promise<boolean> {
  if (!jobId) return false;
  const row = await queryOne<{ status: string; deleted_at: number | null }>(
    `SELECT status, deleted_at FROM jobs WHERE id = ?`,
    [jobId]
  );
  if (!row) return true;
  return row.deleted_at != null || row.status === "cancelled";
}

async function executeTask(row: CpuTaskRow): Promise<void> {
  if (row.kind === "master") await executeMaster(row);
  else if (row.kind === "whisper") await executeWhisper(row);
  else if (row.kind === "concat") await executeConcat(row);
  else if (row.kind === "extract") await executeExtract(row);
  else throw new Error(`unknown cpu task ${row.kind}`);
}

async function executeMaster(row: CpuTaskRow): Promise<void> {
  if (!row.input_path || !row.output_path) throw new Error("master task is missing a path");
  const payload = parsePayload(row.payload_json);
  const extension = typeof payload.extension === "string" ? payload.extension : "mp3";
  const chain = payload.chain === "s2" ? "s2" : "podcast";
  const audio = await downloadFile(row.input_path);
  const mastered = await masterSectionBuffer(audio, extension, process.env, chain);
  if (!mastered) throw new Error("mastering returned no audio");
  if (!(await heartbeatCpuTask(row.id, currentOwner(row)))) {
    throw new Error("cpu lease lost before publish");
  }
  if (await jobStopped(row.job_id)) throw new Error("job cancelled before publish");
  const key = splitKey(row.output_path);
  await uploadFile(key.directory, key.filename, mastered, "audio/mpeg");
}

function currentOwner(row: CpuTaskRow): string {
  return row.owner_token || "";
}

async function executeWhisper(row: CpuTaskRow): Promise<void> {
  if (!row.input_path || !row.output_path) throw new Error("whisper task is missing a path");
  const payload = parsePayload(row.payload_json);
  const source = typeof payload.sourceText === "string" ? payload.sourceText : "";
  const audio = await downloadFile(row.input_path);
  let verdict: { ok: boolean; skipped?: boolean; flags?: string[] };
  try {
    const transcript = await transcribeLocally(audio, process.env, 180_000);
    const aligned = checkTranscriptAlignment(source, transcript);
    verdict = { ok: aligned.flags.length === 0, flags: aligned.flags };
  } catch (err) {
    if (err instanceof CpuSaturatedError) throw err;
    // A missing sidecar or a transcript error keeps the take. The book
    // is not failed, matching the in-process QA rule.
    console.warn(
      `[cpu] whisper skipped for ${row.id}:`,
      err instanceof Error ? err.message : err
    );
    verdict = { ok: true, skipped: true };
  }
  if (!(await heartbeatCpuTask(row.id, currentOwner(row)))) {
    throw new Error("cpu lease lost before publish");
  }
  const key = splitKey(row.output_path);
  await uploadFile(
    key.directory,
    key.filename,
    Buffer.from(JSON.stringify(verdict)),
    "application/json"
  );
}

async function executeConcat(row: CpuTaskRow): Promise<void> {
  if (!row.job_id) throw new Error("concat task is missing a job");
  const { materializeFullAudiobook } = await import("@/lib/tts/concat-audio");
  const { parseSegmentMap } = await import("@/lib/tts/section-index");
  const job = await queryOne<{
    segments_json: string | null;
    total_sections: number | null;
    status: string;
    deleted_at: number | null;
  }>(
    `SELECT segments_json, total_sections, status, deleted_at FROM jobs WHERE id = ?`,
    [row.job_id]
  );
  if (!job || job.deleted_at != null || job.status === "cancelled") {
    throw new Error("job cancelled before concat");
  }
  const segments = parseSegmentMap(job.segments_json);
  const total = job.total_sections ?? segments.length;
  const produced = await materializeFullAudiobook(row.job_id, segments, total, {
    allowHoles: segments.some((segment) => segment.status !== "ready"),
  });
  if (!produced) throw new Error("concat produced no file");
}

async function executeExtract(row: CpuTaskRow): Promise<void> {
  const uploadId = row.upload_id;
  if (!uploadId) throw new Error("extract task is missing an upload");
  const { runExtractOnce } = await import("@/lib/uploads/extract");
  await runExtractOnce(uploadId);
}

function parsePayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // A bad payload fails the attempt below.
  }
  return {};
}

async function dispatchModal(taskId: string): Promise<CpuRunResult> {
  const url = process.env.MODAL_CPU_URL?.trim();
  if (!url) throw new Error("CPU_RUNNER=modal requires MODAL_CPU_URL");
  const parsed = new URL(url);
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("MODAL_CPU_URL is the endpoint host, with no path");
  }
  const timeoutMs = Number(process.env.CPU_DISPATCH_TIMEOUT_MS || "120000");
  const token = process.env.MODAL_CPU_TOKEN || process.env.WORKER_SECRET || "";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ taskId }),
    signal: AbortSignal.timeout(
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000
    ),
  });
  if (response.status === 429) return "deferred";
  if (!response.ok) return "failed";
  const row = await getCpuTask(taskId);
  if (row?.status === "done") return "done";
  if (row?.status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * Claim and run `taskId`, or dispatch it. A finished row returns `done`
 * without running again. A full host returns `deferred` and leaves the
 * row queued.
 */
export async function runCpuTask(taskId: string): Promise<CpuRunResult> {
  const existing = await getCpuTask(taskId);
  if (!existing) return "failed";
  if (existing.status === "done") return "done";
  if (existing.status === "cancelled") return "cancelled";
  if (cpuRunner() === "modal") return dispatchModal(taskId);

  const slot = await tryCpuSlot(slotKind(existing.kind), 0);
  if (slot === null) return "deferred";
  const owner = newToken();
  const claimed = await claimCpuTask(taskId, owner);
  if (!claimed) {
    if (slot !== "unavailable") await slot.release();
    const again = await getCpuTask(taskId);
    if (again?.status === "done") return "done";
    if (again?.status === "cancelled") return "cancelled";
    return "deferred";
  }
  const owned: CpuTaskRow = { ...existing, owner_token: owner, status: "claimed" };
  const beat = setInterval(() => {
    void heartbeatCpuTask(taskId, owner).catch(() => {});
  }, 15_000);
  if (typeof beat.unref === "function") beat.unref();
  try {
    if (await jobStopped(existing.job_id)) {
      await cancelCpuTask(taskId, owner);
      return "cancelled";
    }
    await runInsideCpuTask(() => executeTask(owned));
    const live = await heartbeatCpuTask(taskId, owner);
    if (!live) return "lost";
    const ok = await completeCpuTask(taskId, owner);
    return ok ? "done" : "lost";
  } catch (err) {
    if (err instanceof CpuSaturatedError) {
      await requeueCpuTask(taskId, owner);
      return "deferred";
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("cancelled")) {
      await cancelCpuTask(taskId, owner);
      return "cancelled";
    }
    if (message.includes("lease lost")) return "lost";
    await failCpuTask(taskId, owner, message);
    return "failed";
  } finally {
    clearInterval(beat);
    if (slot !== "unavailable") await slot.release();
  }
}

export async function readWhisperVerdict(
  outputPath: string
): Promise<{ ok: boolean; skipped?: boolean } | null> {
  if (!(await fileExists(outputPath))) return null;
  try {
    const body = JSON.parse((await downloadFile(outputPath)).toString("utf8")) as {
      ok?: boolean;
      skipped?: boolean;
    };
    return { ok: body.ok === true, skipped: body.skipped === true };
  } catch {
    return null;
  }
}

/**
 * Holds this host's ffmpeg permit around the local concat, or dispatches
 * the concat task to Modal. `deferred` means do not publish the book.
 */
export async function holdBookConcat(jobId: string): Promise<
  | { kind: "already"; path: string }
  | { kind: "deferred" }
  | {
      kind: "local";
      release: () => Promise<void>;
      finish: (ok: boolean) => Promise<void>;
    }
> {
  const { enqueueCpuTask } = await import("@/lib/cpu/tasks");
  const id = `concat:${jobId}`;
  const output = `audiobooks/${jobId}/full.mp3`;
  await enqueueCpuTask({
    id,
    kind: "concat",
    jobId,
    outputPath: output,
    inputPath: `audiobooks/${jobId}`,
  });
  const row = await getCpuTask(id);
  if (row?.status === "done" && (await fileExists(output))) {
    return { kind: "already", path: output };
  }
  if (cpuRunner() === "modal") {
    const result = await runCpuTask(id);
    if (result === "done" && (await fileExists(output))) {
      return { kind: "already", path: output };
    }
    return { kind: "deferred" };
  }
  const slot = await tryCpuSlot("ffmpeg", 0);
  if (slot === null) return { kind: "deferred" };
  const owner = newToken();
  const claimed = await claimCpuTask(id, owner);
  if (!claimed) {
    if (slot !== "unavailable") await slot.release();
    const again = await getCpuTask(id);
    if (again?.status === "done" && (await fileExists(output))) {
      return { kind: "already", path: output };
    }
    return { kind: "deferred" };
  }
  let finished = false;
  return {
    kind: "local",
    release: async () => {
      if (slot !== "unavailable") await slot.release();
      if (!finished) await requeueCpuTask(id, owner);
    },
    finish: async (ok: boolean) => {
      finished = true;
      if (ok) await completeCpuTask(id, owner);
      else await failCpuTask(id, owner, "concat failed");
    },
  };
}

export { CPU_TASK_LEASE_SECONDS };
