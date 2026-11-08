/**
 * Modal's platform answers on the deployed hostname when the workspace
 * can no longer accept work. The body says the workspace is disabled.
 * Our handlers do not write that sentence: `modal/cpu_worker.py` has no
 * 404, and the S2 app does not either.
 *
 * The November 2026 stop was confirmed on the workspace budgets tab:
 * a user-set budget was fully used and Modal reported UsageStopped.
 * That was not a payment error. This module does not know the dollar
 * cap, does not ask Modal which request crossed it, and does not
 * re-enable anything. A later disable is still this same platform
 * response; the handler does not invent a cause the body does not give.
 */

export const MODAL_WORKSPACE_DISABLED_MESSAGE =
  "Mastering is unavailable because this Modal workspace is disabled and usage is stopped. Spoken takes are kept and will not be spoken again. Finishing waits until usage is allowed again, or until you approve another way.";

/** Raw audio exists. Mastering did not finish. Do not call that a missing narration. */
export const MASTERING_UNFINISHED_MESSAGE =
  "Mastering did not finish. Spoken takes are kept and will not be spoken again. This is not a complete audiobook. Finishing waits until the mastering service is available, or until you approve another way.";

const DISABLED = /workspace\b[^.\n]{0,160}\bis disabled\b/i;

export function isModalWorkspaceDisabled(body: string): boolean {
  return DISABLED.test(body);
}

/** Drop Modal account ids (`ac-…`) before a body is logged. */
export function redactModalAccount(text: string): string {
  return text.replace(/\bac-[A-Za-z0-9]+\b/g, "ac-redacted");
}

export class ModalWorkspaceDisabledError extends Error {
  constructor(message = MODAL_WORKSPACE_DISABLED_MESSAGE) {
    super(message);
    this.name = "ModalWorkspaceDisabledError";
  }
}

export class CpuProviderUnavailableError extends Error {
  constructor(message = MODAL_WORKSPACE_DISABLED_MESSAGE) {
    super(message);
    this.name = "CpuProviderUnavailableError";
  }
}

/**
 * One completed refusal is enough. Later placements in this process
 * do not POST again until the cooldown passes, so a disabled workspace
 * is not polled once per section.
 */
const BACKOFF_MS = 15 * 60 * 1000;
let unavailableUntil = 0;

export function noteModalWorkspaceDisabled(now = Date.now()): void {
  unavailableUntil = Math.max(unavailableUntil, now + BACKOFF_MS);
}

export function modalWorkspaceDisabledActive(now = Date.now()): boolean {
  return now < unavailableUntil;
}

export function resetModalWorkspaceDisabled(): void {
  unavailableUntil = 0;
}

/**
 * The platform body, turned into the error we throw. Null when this
 * response is some other HTTP failure. Does not include the raw body:
 * that text can carry an account id.
 */
export function modalPlatformRefusal(
  _status: number,
  body: string
): ModalWorkspaceDisabledError | null {
  if (!isModalWorkspaceDisabled(body)) return null;
  noteModalWorkspaceDisabled();
  return new ModalWorkspaceDisabledError();
}

/**
 * Retry must not requeue a book that is waiting on the workspace.
 * Narration holes still use the ordinary retry. Null means retry may proceed.
 */
export function recoveryHoldReason(
  errorMessage: string | null | undefined
): string | null {
  if (!errorMessage) return null;
  if (
    errorMessage.includes("Spoken takes are kept") ||
    errorMessage.includes("workspace is disabled")
  ) {
    return errorMessage;
  }
  return null;
}
