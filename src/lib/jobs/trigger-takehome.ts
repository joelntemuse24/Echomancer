/**
 * Dispatch Whole-book work to Trigger.dev. Next.js only enqueues; Trigger
 * imports `runTakehomeUntilSettled` in-process. Never HTTP `/process`.
 */

import { AppError } from "@/lib/errors";
import { triggerTask } from "@/lib/jobs/trigger-api";

export const TAKEHOME_ADVANCE_TASK_ID = "takehome.advance";

const TRIGGER_MISSING_MESSAGE =
  "Whole book generation is not configured (TRIGGER_SECRET_KEY is missing).";

export function isProductionDispatch(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && !process.env.VITEST)
  );
}

/** Fail loud in production when Trigger cannot be reached — before insert. */
export function assertCanDispatchTakehome(): void {
  if (!isProductionDispatch()) return;
  if (!process.env.TRIGGER_SECRET_KEY?.trim()) {
    throw new AppError(
      "TRIGGER_NOT_CONFIGURED",
      TRIGGER_MISSING_MESSAGE,
      503
    );
  }
}

/**
 * Fire `takehome.advance`. Missing key in production is the caller's problem
 * (`assertCanDispatchTakehome` before insert). After a job row exists, Trigger
 * SDK/REST failures are logged and the job stays `queued` for `takehome.drain`.
 */
export async function enqueueTakehomeAdvance(jobId: string): Promise<void> {
  const key = process.env.TRIGGER_SECRET_KEY?.trim();
  if (!key) {
    if (isProductionDispatch()) {
      console.error(
        `[takehome] TRIGGER_SECRET_KEY missing; job ${jobId} left queued for takehome.drain`
      );
    }
    return;
  }

  try {
    const handle = await triggerTask(
      TAKEHOME_ADVANCE_TASK_ID,
      { jobId },
      { concurrencyKey: jobId }
    );
    console.info(`[takehome] enqueued job ${jobId} run ${handle.id}`);
  } catch (err) {
    console.error(
      `[takehome] Trigger dispatch failed for ${jobId}; job left queued for takehome.drain`,
      err
    );
  }
}
