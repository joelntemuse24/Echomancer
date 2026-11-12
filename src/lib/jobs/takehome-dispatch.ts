/**
 * Dispatch Whole-book work to the always-on VM worker (`WORKER_URL`).
 * Next.js only enqueues; it never synthesizes. If the worker POST fails,
 * the job stays queued for the worker drain loop.
 */

import { AppError } from "@/lib/errors";
import {
  enqueueTakehomeOnWorker,
  isTakehomeWorkerConfigured,
  takehomeWorkerSecret,
  takehomeWorkerUrl,
} from "@/lib/jobs/takehome-worker-client";

const TAKEHOME_MISSING_MESSAGE =
  "Whole book generation is not configured (WORKER_URL is missing).";

export function isProductionDispatch(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && !process.env.VITEST)
  );
}

export function canDispatchTakehome(): boolean {
  return isTakehomeWorkerConfigured();
}

/** Fail loud in production when no Whole-book host can be reached — before insert. */
export function assertCanDispatchTakehome(): void {
  if (!isProductionDispatch()) return;
  if (takehomeWorkerUrl() && !takehomeWorkerSecret()) {
    throw new AppError(
      "TAKEHOME_NOT_CONFIGURED",
      "Whole book generation is not configured (WORKER_URL is set but WORKER_SECRET is missing).",
      503
    );
  }
  if (canDispatchTakehome()) return;
  throw new AppError(
    "TAKEHOME_NOT_CONFIGURED",
    TAKEHOME_MISSING_MESSAGE,
    503
  );
}

export { isTakehomeWorkerConfigured };

/**
 * Wake the VM worker. After a job row exists, a failed POST is logged and
 * the job stays `queued` for the worker drain loop.
 */
export async function enqueueTakehomeAdvance(jobId: string): Promise<void> {
  if (isTakehomeWorkerConfigured()) {
    try {
      await enqueueTakehomeOnWorker(jobId);
      console.info(`[takehome] enqueued job ${jobId} on VM worker`);
      return;
    } catch (err) {
      console.error(
        `[takehome] VM worker dispatch failed for ${jobId}; job left queued for drain`,
        err
      );
      return;
    }
  }

  if (isProductionDispatch()) {
    console.error(`[takehome] WORKER_URL missing; job ${jobId} left queued`);
  }
}
