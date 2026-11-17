/**
 * One stop for cancel, delete, timeout, and worker restart.
 * The database row is updated by the caller. This refuses new remote
 * calls in this process and asks the worker to drain the ones it holds.
 */

import { haltBook, noteDrainRequested } from "@/lib/remote/layer";

export async function stopBookRemotely(jobId: string, reason: string): Promise<void> {
  haltBook(jobId, reason);
  noteDrainRequested(jobId);
  try {
    const { requestBookDrain } = await import("@/lib/jobs/takehome-worker-client");
    await requestBookDrain(jobId);
  } catch (err) {
    console.warn(
      "[remote] drain request failed:",
      err instanceof Error ? err.message : err
    );
  }
}
