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
): Promise<{ segments: JobSegment[]; waiting: boolean; changed: boolean }> {
  let waiting = false;
  let changed = false;
  const next: JobSegment[] = [];
  for (const segment of segments) {
    if (segment.status !== "mastering") {
      next.push(segment);
      continue;
    }
    const whisperId = cpuTaskId("whisper", jobId, segment.index);
    const masterId = cpuTaskId("master", jobId, segment.index);
    const whisper = await getCpuTask(whisperId);
    if (whisper && whisper.status !== "done" && whisper.status !== "failed" && whisper.status !== "cancelled") {
      const ran = await runCpuTask(whisperId);
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
      await runCpuTask(masterId);
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
  return {
    segments: next.reduce((acc, segment) => upsertSegment(acc, segment), [] as JobSegment[]),
    waiting,
    changed,
  };
}

function extensionOf(storagePath: string): string {
  const dot = storagePath.lastIndexOf(".");
  if (dot < 0) return "mp3";
  return storagePath.slice(dot + 1) || "mp3";
}
