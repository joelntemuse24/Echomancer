/**
 * Document extract as a CPU task. Local mode still uses the warm child
 * and holds the task so a second host does not parse the same upload.
 * Modal mode POSTs the task and does not fork a child here.
 */

import { cpuRunner, runCpuTask } from "@/lib/cpu/runner";
import {
  CPU_TASK_LEASE_SECONDS,
  claimCpuTask,
  completeCpuTask,
  cpuTaskId,
  enqueueCpuTask,
  failCpuTask,
  heartbeatCpuTask,
} from "@/lib/cpu/tasks";
import { startNodeExtract } from "@/worker/node-extract";

const owners = new Map<string, string>();
const beats = new Map<string, ReturnType<typeof setInterval>>();

function token(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function acceptDocumentExtract(
  uploadId: string,
  wake: () => void
): Promise<{ started: boolean; queued: boolean }> {
  const id = cpuTaskId("extract", uploadId);
  try {
    await enqueueCpuTask({
      id,
      kind: "extract",
      uploadId,
      outputPath: `pdfs/${uploadId}/content.txt`,
    });
  } catch (err) {
    console.warn(
      `[extract] task enqueue failed for ${uploadId}:`,
      err instanceof Error ? err.message : err
    );
  }

  if (cpuRunner() === "modal") {
    void runCpuTask(id)
      .then((result) => {
        if (result === "done") wake();
      })
      .catch((err) => {
        console.warn(
          `[extract] modal dispatch failed for ${uploadId}:`,
          err instanceof Error ? err.message : err
        );
      });
    return { started: true, queued: true };
  }

  const owner = token();
  const claimed = await claimCpuTask(id, owner).catch(() => false);
  if (!claimed) {
    return { started: false, queued: true };
  }
  owners.set(uploadId, owner);
  const beat = setInterval(() => {
    void heartbeatCpuTask(id, owner, CPU_TASK_LEASE_SECONDS).catch(() => {});
  }, 15_000);
  if (typeof beat.unref === "function") beat.unref();
  beats.set(uploadId, beat);
  return startNodeExtract(uploadId);
}

export async function finishDocumentExtract(uploadId: string, ok: boolean): Promise<void> {
  const owner = owners.get(uploadId);
  const beat = beats.get(uploadId);
  if (beat) clearInterval(beat);
  beats.delete(uploadId);
  owners.delete(uploadId);
  if (!owner) return;
  const id = cpuTaskId("extract", uploadId);
  if (ok) await completeCpuTask(id, owner).catch(() => {});
  else await failCpuTask(id, owner, "extract child failed").catch(() => {});
}
