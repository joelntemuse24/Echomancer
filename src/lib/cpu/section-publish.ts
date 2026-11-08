/**
 * Publishes a synthesized section only when the bytes at the section
 * key are the delivery audio. When mastering is on, the provider take
 * is stored under `raw/` and a CPU task writes `sections/NNNN.mp3`.
 * A full host leaves the section `mastering` and does not copy the raw
 * take onto the section key.
 */

import { downloadFile, fileExists, uploadFile } from "@/lib/storage";
import { padSectionIndex, sectionObjectName, upsertSegment } from "@/lib/tts/section-index";
import { shouldSectionMaster } from "@/lib/tts/section-master";
import type { JobSegment } from "@/lib/tts/types";
import { cpuTaskId, enqueueCpuTask, getCpuTask } from "@/lib/cpu/tasks";
import { readWhisperVerdict, runCpuTask } from "@/lib/cpu/runner";

export interface SectionCommit {
  ready: boolean;
  /** Section object key when ready. Empty while the CPU task is still queued. */
  path: string;
  rawPath?: string;
  contentType: string;
  mastered: boolean;
  /** The transcript rejected the take. The caller may speak it once more. */
  regen?: boolean;
  /** The CPU workspace refused the placement. Do not speak the section again. */
  unavailable?: boolean;
}

export async function commitSectionAudio(input: {
  jobId: string;
  index: number;
  audio: Buffer;
  extension: string;
  contentType: string;
  chain: "podcast" | "s2";
  qaDeferred: boolean;
  sourceText?: string;
}): Promise<SectionCommit> {
  const masterOn = shouldSectionMaster();
  if (!masterOn && !input.qaDeferred) {
    const uploaded = await uploadFile(
      `audiobooks/${input.jobId}`,
      sectionObjectName(input.index, input.extension),
      input.audio,
      input.contentType
    );
    return {
      ready: true,
      path: uploaded.path,
      contentType: input.contentType,
      mastered: false,
    };
  }

  const raw = await uploadFile(
    `audiobooks/${input.jobId}`,
    `raw/${padSectionIndex(input.index)}.${input.extension}`,
    input.audio,
    input.contentType
  );

  if (input.qaDeferred) {
    const whisperId = cpuTaskId("whisper", input.jobId, input.index);
    const verdictPath = `audiobooks/${input.jobId}/qa/${padSectionIndex(input.index)}.json`;
    await enqueueCpuTask({
      id: whisperId,
      kind: "whisper",
      jobId: input.jobId,
      sectionIndex: input.index,
      inputPath: raw.path,
      outputPath: verdictPath,
      payload: {
        sourceText: input.sourceText ?? "",
        chain: input.chain,
        extension: input.extension,
        contentType: input.contentType,
        master: masterOn,
      },
    });
    const ran = await runCpuTask(whisperId);
    if (ran !== "done") {
      return {
        ready: false,
        path: "",
        rawPath: raw.path,
        contentType: input.contentType,
        mastered: false,
      };
    }
    const verdict = await readWhisperVerdict(verdictPath);
    if (verdict && !verdict.ok && !verdict.skipped) {
      return {
        ready: false,
        path: "",
        rawPath: raw.path,
        contentType: input.contentType,
        mastered: false,
        regen: true,
      };
    }
  }

  if (!masterOn) {
    const uploaded = await uploadFile(
      `audiobooks/${input.jobId}`,
      sectionObjectName(input.index, input.extension),
      input.audio,
      input.contentType
    );
    return {
      ready: true,
      path: uploaded.path,
      rawPath: raw.path,
      contentType: input.contentType,
      mastered: false,
    };
  }

  const output = `audiobooks/${input.jobId}/${sectionObjectName(input.index, "mp3")}`;
  const masterId = cpuTaskId("master", input.jobId, input.index);
  await enqueueCpuTask({
    id: masterId,
    kind: "master",
    jobId: input.jobId,
    sectionIndex: input.index,
    inputPath: raw.path,
    outputPath: output,
    payload: { chain: input.chain, extension: input.extension },
  });
  const ran = await runCpuTask(masterId);
  if (ran === "unavailable") {
    return {
      ready: false,
      path: "",
      rawPath: raw.path,
      contentType: input.contentType,
      mastered: false,
      unavailable: true,
    };
  }
  if (ran !== "done" || !(await fileExists(output))) {
    return {
      ready: false,
      path: "",
      rawPath: raw.path,
      contentType: input.contentType,
      mastered: false,
    };
  }
  return {
    ready: true,
    path: output,
    rawPath: raw.path,
    contentType: "audio/mpeg",
    mastered: true,
  };
}

/**
 * Finish CPU tasks left by a crashed tick. A mastered object is published
 * only when the task is `done` and the section key exists. Raw bytes are
 * never copied onto that key here.
 */
export async function promoteFinishedSections(
  jobId: string,
  segments: JobSegment[]
): Promise<{
  segments: JobSegment[];
  waiting: boolean;
  changed: boolean;
  unavailable?: boolean;
}> {
  let waiting = false;
  let changed = false;
  const next: JobSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.status !== "mastering") {
      next.push(segment);
      continue;
    }
    const whisperId = cpuTaskId("whisper", jobId, segment.index);
    const masterId = cpuTaskId("master", jobId, segment.index);
    const whisper = await getCpuTask(whisperId);
    if (whisper && whisper.status !== "done" && whisper.status !== "failed" && whisper.status !== "cancelled") {
      const ran = await runCpuTask(whisperId);
      if (ran === "unavailable") {
        return finishPromote(next, segments, i, segment, { waiting: true, changed, unavailable: true });
      }
      if (ran !== "done") {
        waiting = true;
        next.push(segment);
        continue;
      }
    }
    const whisperNow = whisper ? await getCpuTask(whisperId) : null;
    if (whisperNow?.status === "done" && whisperNow.output_path) {
      const verdict = await readWhisperVerdict(whisperNow.output_path);
      if (verdict && !verdict.ok && !verdict.skipped) {
        changed = true;
        next.push({
          index: segment.index,
          path: "",
          status: "retry",
          error: "transcript check asked for another take",
          rawPath: segment.rawPath,
        });
        continue;
      }
    }
    let master = await getCpuTask(masterId);
    if (!master && segment.rawPath && shouldSectionMaster()) {
      await enqueueCpuTask({
        id: masterId,
        kind: "master",
        jobId,
        sectionIndex: segment.index,
        inputPath: segment.rawPath,
        outputPath: `audiobooks/${jobId}/${sectionObjectName(segment.index, "mp3")}`,
        payload: { chain: "podcast", extension: extensionOf(segment.rawPath) },
      });
      master = await getCpuTask(masterId);
    }
    if (master && master.status !== "done" && master.status !== "failed" && master.status !== "cancelled") {
      const ran = await runCpuTask(masterId);
      if (ran === "unavailable") {
        return finishPromote(next, segments, i, segment, { waiting: true, changed, unavailable: true });
      }
      master = await getCpuTask(masterId);
    }
    if (master?.status === "done" && master.output_path && (await fileExists(master.output_path))) {
      changed = true;
      next.push({
        index: segment.index,
        path: master.output_path,
        status: "ready",
        contentType: "audio/mpeg",
        mastered: true,
        rawPath: segment.rawPath,
      });
      continue;
    }
    if (master?.status === "failed" || master?.status === "cancelled") {
      changed = true;
      next.push({
        index: segment.index,
        path: "",
        status: "failed",
        error: master.error_message || "mastering did not finish",
        rawPath: segment.rawPath,
      });
      continue;
    }
    if (!master && segment.rawPath && !shouldSectionMaster()) {
      const audio = await downloadFile(segment.rawPath);
      const extension = extensionOf(segment.rawPath);
      const uploaded = await uploadFile(
        `audiobooks/${jobId}`,
        sectionObjectName(segment.index, extension),
        audio,
        "application/octet-stream"
      );
      changed = true;
      next.push({
        index: segment.index,
        path: uploaded.path,
        status: "ready",
        rawPath: segment.rawPath,
        mastered: false,
      });
      continue;
    }
    waiting = true;
    next.push(segment);
  }
  return foldPromote(next, waiting, changed);
}

function finishPromote(
  next: JobSegment[],
  segments: JobSegment[],
  index: number,
  current: JobSegment,
  flags: { waiting: boolean; changed: boolean; unavailable: boolean }
): { segments: JobSegment[]; waiting: boolean; changed: boolean; unavailable: boolean } {
  next.push(current);
  for (let j = index + 1; j < segments.length; j++) next.push(segments[j]!);
  return { ...foldPromote(next, flags.waiting, flags.changed), unavailable: true };
}

function foldPromote(
  next: JobSegment[],
  waiting: boolean,
  changed: boolean
): { segments: JobSegment[]; waiting: boolean; changed: boolean } {
  return {
    segments: next.reduce((acc, segment) => upsertSegment(acc, segment), [] as JobSegment[]),
    waiting,
    changed,
  };
}

/**
 * A crash after the raw upload, before the segment row was saved, must
 * not speak the section again. An existing CPU task, or a raw object at
 * the lowest hole, becomes a `mastering` row. Later holes are not
 * probed once a hole has no raw take, so a fresh book does not HEAD
 * every section.
 */
export async function recoverOrphanRawSections(input: {
  jobId: string;
  segments: JobSegment[];
  total: number;
  sectionText?: (index: number) => string;
}): Promise<{ segments: JobSegment[]; recovered: number }> {
  const seen = new Set(input.segments.map((segment) => segment.index));
  const next = [...input.segments];
  let recovered = 0;
  const { query } = await import("@/lib/turso");
  const tasks = await query<{
    section_index: number | null;
    input_path: string | null;
    kind: string;
    status: string;
  }>(
    `SELECT section_index, input_path, kind, status FROM cpu_tasks
     WHERE job_id = ? AND status != 'cancelled'`,
    [input.jobId]
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(msg)) return [];
    throw err;
  });
  const taskByIndex = new Map<number, { input_path: string | null; kind: string; status: string }>();
  for (const task of tasks) {
    if (task.section_index == null) continue;
    taskByIndex.set(task.section_index, task);
  }

  const park = async (index: number, rawPath: string, hasMaster: boolean) => {
    if (shouldSectionMaster() && !hasMaster) {
      await enqueueCpuTask({
        id: cpuTaskId("master", input.jobId, index),
        kind: "master",
        jobId: input.jobId,
        sectionIndex: index,
        inputPath: rawPath,
        outputPath: `audiobooks/${input.jobId}/${sectionObjectName(index, "mp3")}`,
        payload: {
          chain: "podcast",
          extension: extensionOf(rawPath),
          sourceText: input.sectionText?.(index) ?? "",
        },
      });
    }
    next.push({ index, path: "", status: "mastering", rawPath });
    seen.add(index);
    recovered += 1;
  };

  for (const [index, task] of taskByIndex) {
    if (seen.has(index) || index < 0 || index >= input.total) continue;
    if (!task.input_path || !(await fileExists(task.input_path))) continue;
    await park(index, task.input_path, task.kind === "master" && task.status !== "cancelled");
  }

  for (let index = 0; index < input.total; index++) {
    if (seen.has(index)) continue;
    let rawPath = "";
    for (const extension of ["wav", "mp3", "ogg"]) {
      const candidate = `audiobooks/${input.jobId}/raw/${padSectionIndex(index)}.${extension}`;
      if (await fileExists(candidate)) {
        rawPath = candidate;
        break;
      }
    }
    if (!rawPath) break;
    await park(index, rawPath, false);
  }

  return {
    segments: next.sort((a, b) => a.index - b.index),
    recovered,
  };
}

function extensionOf(storagePath: string): string {
  const dot = storagePath.lastIndexOf(".");
  if (dot < 0) return "mp3";
  return storagePath.slice(dot + 1) || "mp3";
}
