/**
 * One vocabulary for every paid remote call: S2, Fish, Kokoro, Modal CPU,
 * previews, and prewarm. Call sites record through this shape so a retry,
 * a cancel, and a daily budget all see the same row.
 */

export const REMOTE_PROVIDERS = [
  "s2-clone",
  "fish",
  "kokoro",
  "modal-cpu",
  "preview",
  "prewarm",
] as const;

export type RemoteProvider = (typeof REMOTE_PROVIDERS)[number];

export type RemotePath = "book" | "warm" | "cover" | "preview" | "health";

/** Terminal rows are success, failure, cancelled, timeout. still_live is not. */
export type RemoteOutcome =
  | "started"
  | "success"
  | "failure"
  | "cancelled"
  | "timeout"
  | "still_live"
  | "refused"
  | "joined";

export type RemoteEvent = {
  id: string;
  flightKey: string;
  idempotencyKey: string;
  provider: RemoteProvider;
  path: RemotePath;
  jobId?: string;
  section?: string;
  callId?: string;
  /** Client tag echoed in the Modal input, so a listing can be mapped to this book. */
  callTag?: string;
  outcome: RemoteOutcome;
  startedAt: number;
  endedAt?: number;
  estCostUsd?: number;
  error?: string;
};

export class RemoteCallRefused extends Error {
  constructor(
    message: string,
    readonly code: "cancelled" | "budget" | "in_flight"
  ) {
    super(message);
    this.name = "RemoteCallRefused";
  }
}
