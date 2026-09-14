/**
 * Dispatch Whole-book work. Preferred host is the always-on VM worker
 * (`WORKER_URL`). Trigger.dev remains an optional fallback when the worker
 * URL is unset, or when `TAKEHOME_TRIGGER_FALLBACK=1` and the worker POST
 * fails. Next.js only enqueues; it never synthesizes.
 */

import { AppError } from "@/lib/errors";
import { triggerTask } from "@/lib/jobs/trigger-api";
import {
  enqueueTakehomeOnWorker,
  isTakehomeWorkerConfigured,
  takehomeWorkerSecret,
  takehomeWorkerUrl,
} from "@/lib/jobs/takehome-worker-client";

export const TAKEHOME_ADVANCE_TASK_ID = "takehome.advance";

const TAKEHOME_MISSING_MESSAGE =
  "Whole book generation is not configured (WORKER_URL or TRIGGER_SECRET_KEY is missing).";

export function isProductionDispatch(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && !process.env.VITEST)
  );
}

export function isTriggerTakehomeConfigured(): boolean {
  return Boolean(process.env.TRIGGER_SECRET_KEY?.trim());
}

export function isTakehomeTriggerFallbackEnabled(): boolean {
  const raw = process.env.TAKEHOME_TRIGGER_FALLBACK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Set `TAKEHOME_TRIGGER_DRAIN=0` on the Trigger project once the VM is primary. */
export function isTriggerTakehomeDrainDisabled(): boolean {
  const raw = process.env.TAKEHOME_TRIGGER_DRAIN?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

export function canDispatchTakehome(): boolean {
  return isTakehomeWorkerConfigured() || isTriggerTakehomeConfigured();
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
 * Wake the VM worker (preferred) or Trigger `takehome.advance`.
 * After a job row exists, dispatch failures are logged and the job stays
 * `queued` for the worker drain loop / `takehome.drain`.
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
      if (
        isTakehomeTriggerFallbackEnabled() &&
        isTriggerTakehomeConfigured()
      ) {
        await enqueueOnTrigger(jobId);
      }
      return;
    }
  }

  if (isTriggerTakehomeConfigured()) {
    await enqueueOnTrigger(jobId);
    return;
  }

  if (isProductionDispatch()) {
    console.error(
      `[takehome] WORKER_URL and TRIGGER_SECRET_KEY missing; job ${jobId} left queued`
    );
  }
}

async function enqueueOnTrigger(jobId: string): Promise<void> {
  try {
    const handle = await triggerTask(
      TAKEHOME_ADVANCE_TASK_ID,
      { jobId },
      { concurrencyKey: jobId }
    );
    console.info(`[takehome] enqueued job ${jobId} Trigger run ${handle.id}`);
  } catch (err) {
    console.error(
      `[takehome] Trigger dispatch failed for ${jobId}; job left queued for takehome.drain`,
      err
    );
  }
}
