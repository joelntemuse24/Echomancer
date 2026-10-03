/**
 * Where a document extract runs.
 *
 * Every upload goes to the always-on Node worker (the Contabo take-home
 * process). The Cloudflare extract Worker is on the Free plan (~10 ms CPU)
 * and is killed on a real PDF before it can write `content.txt` or a failed
 * status. It is only the fallback when the Node worker is unreachable or
 * reports itself unhealthy. A row that stops making progress is marked
 * failed so the voice page stops waiting.
 */

export type ExtractHost = "cloudflare" | "node" | "inline";

export type ExtractTarget = "node" | "cloudflare" | "inline" | "vercel";

/** One Cloudflare re-dispatch while that fallback attempt is still silent. */
export const DEFAULT_EXTRACT_CF_RESEND_SECONDS = 45;

/**
 * After a Cloudflare fallback has produced nothing for this long, try the
 * Node worker again (it may have recovered).
 */
export const DEFAULT_EXTRACT_NODE_HANDOFF_SECONDS = 75;

/** `uploaded` rows with no host yet are re-dispatched on this cadence. */
export const DEFAULT_EXTRACT_UPLOADED_NUDGE_SECONDS = 20;

/**
 * Node heartbeats `extract_started_at` while a child is parsing. Older than
 * this means the process died.
 */
export const DEFAULT_EXTRACT_NODE_HEARTBEAT_STALE_SECONDS = 180;

/** Wall clock from the first accept, including a live heartbeat. */
export const DEFAULT_EXTRACT_NODE_HARD_CAP_SECONDS = 20 * 60;

/** Dispatches across both hosts. The next stale poll after this fails the row. */
export const DEFAULT_EXTRACT_MAX_ATTEMPTS = 4;

export const EXTRACT_STUCK_MESSAGE =
  "This file took too long to read. Try again.";

export interface ExtractRouteConfig {
  cfResendSeconds: number;
  nodeHandoffSeconds: number;
  uploadedNudgeSeconds: number;
  nodeHeartbeatStaleSeconds: number;
  nodeHardCapSeconds: number;
  maxAttempts: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function extractRouteConfig(
  env: NodeJS.ProcessEnv = process.env
): ExtractRouteConfig {
  return {
    cfResendSeconds: positiveInt(
      env.EXTRACT_CF_RESEND_SECONDS,
      DEFAULT_EXTRACT_CF_RESEND_SECONDS
    ),
    nodeHandoffSeconds: positiveInt(
      env.EXTRACT_NODE_HANDOFF_SECONDS,
      DEFAULT_EXTRACT_NODE_HANDOFF_SECONDS
    ),
    uploadedNudgeSeconds: positiveInt(
      env.EXTRACT_UPLOADED_NUDGE_SECONDS,
      DEFAULT_EXTRACT_UPLOADED_NUDGE_SECONDS
    ),
    nodeHeartbeatStaleSeconds: positiveInt(
      env.EXTRACT_NODE_HEARTBEAT_STALE_SECONDS,
      DEFAULT_EXTRACT_NODE_HEARTBEAT_STALE_SECONDS
    ),
    nodeHardCapSeconds: positiveInt(
      env.EXTRACT_NODE_HARD_CAP_SECONDS,
      DEFAULT_EXTRACT_NODE_HARD_CAP_SECONDS
    ),
    maxAttempts: positiveInt(
      env.EXTRACT_MAX_ATTEMPTS,
      DEFAULT_EXTRACT_MAX_ATTEMPTS
    ),
  };
}

export interface InitialExtractInput {
  byteSize: number;
  cfConfigured: boolean;
  nodeConfigured: boolean;
  production: boolean;
  inlineMaxBytes: number;
}

/**
 * First choice from `POST /api/pdf/upload/[id]`. Format and size do not
 * matter: Node takes every document when `WORKER_URL` is set. Cloudflare
 * is chosen only when Node is not configured. A Node POST that then fails
 * (unreachable or unhealthy) is handled by the dispatcher, which falls
 * back to Cloudflare.
 */
export function chooseInitialExtractTarget(
  input: InitialExtractInput
): ExtractTarget {
  if (input.nodeConfigured) return "node";
  if (input.cfConfigured) return "cloudflare";
  if (!input.production) return "inline";
  if (input.byteSize > 0 && input.byteSize <= input.inlineMaxBytes) {
    return "inline";
  }
  return "vercel";
}

export type ExtractNudge =
  | { action: "wait" }
  | { action: "dispatch"; target: "node" | "cloudflare" }
  | { action: "fail"; message: string };

export interface ExtractNudgeInput {
  status: string;
  extractHost: string | null;
  extractAttempts: number;
  /** Unix seconds. Null when this row has never been claimed. */
  extractStartedAt: number | null;
  /** Unix seconds of the first accept. Not heartbeated and not reset. */
  extractAcceptedAt: number | null;
  now: number;
  nodeConfigured: boolean;
  cfConfigured: boolean;
}

function ageSeconds(startedAt: number | null, now: number): number {
  if (startedAt == null || startedAt <= 0) return Number.POSITIVE_INFINITY;
  return now - startedAt;
}

/**
 * Status-poll decision.
 *
 * Node owns the row until its heartbeat goes stale or the hard cap hits.
 * Cloudflare owns the row only after Node could not take the job. One
 * Cloudflare re-send, then Node again once the handoff window has elapsed.
 * A legacy `extracting` row with no host (the Free-plan Worker died without
 * writing one) is handed to Node on the next poll.
 */
export function decideExtractNudge(
  input: ExtractNudgeInput,
  config: ExtractRouteConfig = extractRouteConfig()
): ExtractNudge {
  if (input.status !== "uploaded" && input.status !== "extracting") {
    return { action: "wait" };
  }

  const age = ageSeconds(input.extractStartedAt, input.now);
  const attempts = input.extractAttempts;
  const host = input.extractHost;
  const accepted = input.extractAcceptedAt ?? 0;
  if (accepted > 0 && input.now - accepted >= config.nodeHardCapSeconds) {
    return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
  }

  const staleLimit =
    host === "node"
      ? config.nodeHeartbeatStaleSeconds
      : config.nodeHandoffSeconds;
  if (attempts >= config.maxAttempts && age >= staleLimit) {
    return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
  }

  if (host === "node") {
    if (age < config.nodeHeartbeatStaleSeconds) return { action: "wait" };
    if (input.nodeConfigured && attempts < config.maxAttempts) {
      return { action: "dispatch", target: "node" };
    }
    if (input.cfConfigured && attempts < config.maxAttempts) {
      return { action: "dispatch", target: "cloudflare" };
    }
    return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
  }

  // `uploaded` means the bytes are in storage and extract has not started
  // (or a dispatch was rolled back). Twenty seconds is the re-send, even
  // when a previous attempt already recorded a host.
  if (input.status === "uploaded") {
    if (
      input.extractStartedAt != null &&
      input.extractStartedAt > 0 &&
      age < config.uploadedNudgeSeconds
    ) {
      return { action: "wait" };
    }
    if (input.nodeConfigured) return { action: "dispatch", target: "node" };
    if (input.cfConfigured) return { action: "dispatch", target: "cloudflare" };
    return { action: "wait" };
  }

  // The previous Cloudflare worker never recorded a host. Send it to Node
  // immediately when Node is up; otherwise end it once the window elapses.
  if (input.status === "extracting" && !host) {
    if (input.nodeConfigured) return { action: "dispatch", target: "node" };
    if (age >= config.nodeHandoffSeconds || attempts >= 2) {
      return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
    }
    if (input.cfConfigured && age >= config.cfResendSeconds) {
      return { action: "dispatch", target: "cloudflare" };
    }
    return { action: "wait" };
  }

  if (host === "cloudflare") {
    if (input.nodeConfigured && age >= config.nodeHandoffSeconds) {
      return { action: "dispatch", target: "node" };
    }
    if (
      input.cfConfigured &&
      attempts < 2 &&
      age >= config.cfResendSeconds
    ) {
      return { action: "dispatch", target: "cloudflare" };
    }
    if (age >= config.nodeHandoffSeconds) {
      return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
    }
    return { action: "wait" };
  }

  return { action: "wait" };
}
