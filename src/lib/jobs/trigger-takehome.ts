/**
 * Dispatch Whole-book work to Trigger.dev. Next.js only enqueues; Trigger
 * imports `runTakehomeUntilSettled` in-process. Never HTTP `/process`.
 */

export const TAKEHOME_ADVANCE_TASK_ID = "takehome.advance";

export function isProductionDispatch(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && !process.env.VITEST)
  );
}

/** Fail loud in production when Trigger cannot be reached. */
export function assertCanDispatchTakehome(): void {
  if (!isProductionDispatch()) return;
  if (!process.env.TRIGGER_SECRET_KEY?.trim()) {
    throw new Error(
      "TRIGGER_SECRET_KEY is not configured — cannot start Whole book generation"
    );
  }
}

export async function enqueueTakehomeAdvance(jobId: string): Promise<void> {
  const key = process.env.TRIGGER_SECRET_KEY?.trim();
  if (!key) {
    if (isProductionDispatch()) {
      throw new Error(
        "TRIGGER_SECRET_KEY is not configured — cannot start Whole book generation"
      );
    }
    return;
  }

  const { tasks } = await import("@trigger.dev/sdk");
  await tasks.trigger(
    TAKEHOME_ADVANCE_TASK_ID,
    { jobId },
    { concurrencyKey: jobId }
  );
}
