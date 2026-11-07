import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The lease a take-home tick is holding. Provider slots renew with this
 * token on the existing heartbeat, so a second process cannot treat a live
 * call as abandoned, and a dead process stops renewing.
 */
export const takehomeLeaseContext = new AsyncLocalStorage<{
  token: string;
  jobId: string;
}>();

export function currentTakehomeLease():
  | { token: string; jobId: string }
  | undefined {
  return takehomeLeaseContext.getStore();
}
