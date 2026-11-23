/**
 * Publishes a synthesized section only when the bytes at the section
 * key are the delivery audio. When mastering is on, the provider take
 * is stored under `raw/` and a CPU task writes `sections/NNNN.mp3`.
 * A full host leaves the section `mastering` and does not copy the raw
 * take onto the section key.
 */

import { downloadFile, fileExists, uploadFile } from "@/lib/storage";
import { jobAudiobookClosed } from "@/lib/jobs/job-audiobook-closed";
import { padSectionIndex, sectionObjectName, upsertSegment } from "@/lib/tts/section-index";
import { shouldSectionMaster } from "@/lib/tts/section-master";
import type { JobSegment } from "@/lib/tts/types";
import { cpuTaskId, enqueueCpuTask, getCpuTask } from "@/lib/cpu/tasks";
import { readWhisperVerdict, runCpuTask } from "@/lib/cpu/runner";
import {
  decideMasterOutcome,
  masterAcceptRetries,
} from "@/lib/cpu/master-tail";

/**
 * Run one CPU task, and re-post it while the answer is "a container has the
 * placement but has not heartbeated yet".
 *
 * `runCpuTask` returns `accepted` as soon as the accept window ends, which on a
 * cold CPU container is the normal first answer: the placement lease is held,
 * the work is starting, and there is nothing wrong with the section. The old
 * code treated that as "mastering is backlogged, come back next tick", and with
 * a 15 s drain interval that is one whole tick per cold start — the tail this
 * module exists to shorten.
 *
 * Re-posting the same task id is safe by construction and cannot duplicate the
 * work:
 *
 *  - `claimCpuTask` only succeeds when the previous lease has expired, so a
 *    live owner is never displaced;
 *  - `resultFromRow` returns `accepted` while the lease is still live, so a
 *    re-post reads the same row instead of starting a second pass;
 *  - the row is owner-fenced, so a late completion from the first placement
 *    still publishes exactly once.
 *
 * `TTS_MASTER_ACCEPT_RETRIES=0` restores the single-post behaviour.
 */
async function runCpuTaskWithAcceptRetry(
  taskId: string,
  opts?: { retries?: number; sleep?: (ms: number) => Promise<void> }
): Promise<{ result: Awaited<ReturnType<typeof runCpuTask>>; retries: number }> {
  const retries = Math.max(0, opts?.retries ?? masterAcceptRetries());
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await runCpuTask(taskId);
  let used = 0;
  while (result === "accepted" && used < retries) {
    // The container has the placement. A short pause keeps this from becoming a
    // poll loop; the accept window itself is what bounds each attempt.
    await sleep(1_000);
    used += 1;
    result = await runCpuTask(taskId);
  }
  return { result, retries: used };
}


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
  if (await jobAudiobookClosed(input.jobId)) {
    return {
      ready: false,
      path: "",
      contentType: input.contentType,
      mastered: false,
    };
  }
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
      // A transcript check that has not answered is not a rejected take. The
      // raw object is stored and the row stays `mastering`, so the next tick
      // (or `promoteFinishedSections`) finishes it. `accepted` is the cold
      // container holding the placement, which is why it is not a failure.
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
  // A cold CPU container answers `accepted` (placement held, not yet
  // heartbeating) before it answers `done`. Giving up there cost one whole
  // drain interval per cold start, which is the tail this fixes.
  const { result: ran } = await runCpuTaskWithAcceptRetry(masterId);
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
  const master = await getCpuTask(masterId);
  // A `done` row is required: an object at the output key without the row
  // being done is a half-written upload from a lost lease, and publishing it
  // would ship a truncated section.
  const outputExists = (await fileExists(output)) && Boolean(master && master.status === "done");
  const outcome = decideMasterOutcome({
    result: ran,
    attemptsLeft: 0,
    outputExists,
    error: master?.error_message ?? null,
  });
  if (outcome.kind === "failed") {
    // A real master failure (ffmpeg exited, or the pass returned nothing).
    // The caller keeps the raw take and does not publish the section.
    console.warn(
      `[cpu] master ${masterId} failed: ${outcome.reason}`
    );
    return {
      ready: false,
      path: "",
      rawPath: raw.path,
      contentType: input.contentType,
      mastered: false,
    };
  }
  if (outcome.kind === "queued") {
    // Placed and still running, or the host was saturated before it started.
    // Either way the raw take is stored and the section is not published as
    // mastered: `promoteFinishedSections` finishes it on a later tick.
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
