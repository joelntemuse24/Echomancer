/**
 * Remaster verified raw takes. Does not synthesize, does not call Modal,
 * and does not mark a partial book ready.
 *
 * Dry-run is the default. `--apply` is refused unless the caller confirms
 * the mastering service is available again, or explicitly approves local
 * mastering on this machine. Neither flag is implied. This module does
 * not change a workspace budget and does not re-enable usage.
 */

import { createHash } from "node:crypto";
import { fileExists, uploadFile } from "@/lib/storage";
import { execute, query, queryOne } from "@/lib/turso";
import { cpuTaskId, ensureCpuTaskTable, getCpuTask, reopenCpuTaskForRaw } from "@/lib/cpu/tasks";
import { sectionObjectName } from "@/lib/tts/section-index";
import type { JobSegment } from "@/lib/tts/types";

export interface RawRemasterPlan {
  readyKept: number[];
  remaster: number[];
  missingRaw: number[];
  alreadyMastering: number[];
  /** True only when every index is ready or covered by a verified raw take. */
  concatReset: boolean;
}

export type RawRemasterMode = "dry-run" | "service-available" | "approve-local";

export interface RawRemasterResult extends RawRemasterPlan {
  applied: boolean;
  backupPath: string | null;
  mode: RawRemasterMode;
}

export async function planRawRemaster(input: {
  segments: JobSegment[];
  total: number;
  exists: (path: string) => Promise<boolean>;
}): Promise<RawRemasterPlan> {
  const readyKept: number[] = [];
  const remaster: number[] = [];
  const missingRaw: number[] = [];
  const alreadyMastering: number[] = [];
  const byIndex = new Map(input.segments.map((segment) => [segment.index, segment]));
  for (let index = 0; index < input.total; index++) {
    const segment = byIndex.get(index);
    if (segment?.status === "ready" && segment.path) {
      readyKept.push(index);
      continue;
    }
    if (segment?.status === "mastering" && segment.rawPath) {
      if (await input.exists(segment.rawPath)) alreadyMastering.push(index);
      else missingRaw.push(index);
      continue;
    }
    if ((segment?.status === "failed" || segment?.status === "retry") && segment.rawPath) {
      if (await input.exists(segment.rawPath)) remaster.push(index);
      else missingRaw.push(index);
      continue;
    }
    missingRaw.push(index);
  }
  const covered = new Set([...readyKept, ...remaster, ...alreadyMastering]);
  return {
    readyKept,
    remaster,
    missingRaw,
    alreadyMastering,
    concatReset: missingRaw.length === 0 && covered.size === input.total && input.total > 0,
  };
}

function parsePayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // A bad payload is replaced with the chain we can see on the raw key.
  }
  return {};
}

export async function applyRawRemaster(input: {
  jobId: string;
  mode: RawRemasterMode;
}): Promise<RawRemasterResult> {
  const job = await queryOne<{
    status: string;
    deleted_at: number | null;
    segments_json: string | null;
    total_sections: number | null;
  }>(
    `SELECT status, deleted_at, segments_json, total_sections FROM jobs WHERE id = ?`,
    [input.jobId]
  );
  if (!job || job.deleted_at != null || job.status === "cancelled") {
    throw new Error("job is not open for a raw remaster");
  }
  if (job.status === "ready") {
    throw new Error("job is already ready");
  }
  const segments = parseSegments(job.segments_json);
  const total =
    typeof job.total_sections === "number" && job.total_sections > 0
      ? job.total_sections
      : segments.length;
  const plan = await planRawRemaster({
    segments,
    total,
    exists: (path) => fileExists(path),
  });
  if (input.mode === "dry-run") {
    return { ...plan, applied: false, backupPath: null, mode: input.mode };
  }
  if (plan.remaster.length === 0 && plan.alreadyMastering.length === 0 && !plan.concatReset) {
    return { ...plan, applied: false, backupPath: null, mode: input.mode };
  }

  await ensureCpuTaskTable();
  const tasks = await query<Record<string, unknown>>(
    `SELECT * FROM cpu_tasks WHERE job_id = ?`,
    [input.jobId]
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = await uploadFile(
    `audiobooks/${input.jobId}/repair-backups`,
    `${stamp}.json`,
    Buffer.from(
      JSON.stringify({
        jobId: input.jobId,
        status: job.status,
        segments,
        tasks,
        mode: input.mode,
      })
    ),
    "application/json"
  );

  const approveLocal = input.mode === "approve-local";
  const nextSegments = segments.map((segment) => ({ ...segment }));
  const byIndex = new Map(nextSegments.map((segment) => [segment.index, segment]));
  for (const index of [...plan.remaster, ...plan.alreadyMastering]) {
    const segment = byIndex.get(index);
    const rawPath = segment?.rawPath;
    if (!segment || !rawPath) continue;
    const taskId = cpuTaskId("master", input.jobId, index);
    const existing = await getCpuTask(taskId);
    const payload = parsePayload(existing?.payload_json ?? null);
    if (approveLocal) payload.approvedLocal = true;
    else delete payload.approvedLocal;
    if (typeof payload.extension !== "string") {
      const dot = rawPath.lastIndexOf(".");
      payload.extension = dot >= 0 ? rawPath.slice(dot + 1) : "mp3";
    }
    if (payload.chain !== "s2" && payload.chain !== "podcast") payload.chain = "podcast";
    await reopenCpuTaskForRaw({
      id: taskId,
      kind: "master",
      jobId: input.jobId,
      sectionIndex: index,
      inputPath: rawPath,
      outputPath:
        existing?.output_path ||
        `audiobooks/${input.jobId}/${sectionObjectName(index, "mp3")}`,
      payload,
    });
    segment.status = "mastering";
    segment.path = "";
    segment.error = undefined;
  }

  if (plan.concatReset) {
    const concatId = `concat:${input.jobId}`;
    const existing = await getCpuTask(concatId);
    const payload = parsePayload(existing?.payload_json ?? null);
    if (approveLocal) payload.approvedLocal = true;
    else delete payload.approvedLocal;
    await reopenCpuTaskForRaw({
      id: concatId,
      kind: "concat",
      jobId: input.jobId,
      inputPath: `audiobooks/${input.jobId}`,
      outputPath: existing?.output_path || `audiobooks/${input.jobId}/full.mp3`,
      payload,
    });
  }

  const ready = plan.readyKept.length;
  await execute(
    `UPDATE jobs SET status = 'queued', error_message = NULL, warning = NULL,
       segments_json = ?, progress = ?,
       processing_lease_token = NULL, lease_expires_at = NULL,
       processing_started_at = NULL, sched_not_before = NULL,
       updated_at = unixepoch()
     WHERE id = ? AND status NOT IN ('ready', 'cancelled') AND deleted_at IS NULL`,
    [
      JSON.stringify(nextSegments),
      total > 0 ? Math.min(99, Math.round((ready / total) * 100)) : 0,
      input.jobId,
    ]
  );

  return { ...plan, applied: true, backupPath: backup.path, mode: input.mode };
}

function parseSegments(json: string | null): JobSegment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (segment): segment is JobSegment =>
        Boolean(segment) &&
        typeof segment === "object" &&
        typeof (segment as JobSegment).index === "number"
    );
  } catch {
    return [];
  }
}

/** Stable short hash of ready section paths. Tests use it to prove they did not move. */
export function readyPathFingerprint(segments: JobSegment[]): string {
  const ready = segments
    .filter((segment) => segment.status === "ready" && segment.path)
    .map((segment) => `${segment.index}:${segment.path}`)
    .sort();
  return createHash("sha256").update(ready.join("\n")).digest("hex");
}
