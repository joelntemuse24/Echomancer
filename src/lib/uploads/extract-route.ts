/**
 * Where a document extract runs.
 *
 * Every upload goes to the always-on Node worker (the Contabo take-home
 * process). The Cloudflare extract Worker is on the Free plan (~10 ms CPU)
 * and is killed on a real PDF before it can write `content.txt` or a failed
 * status. It is the fallback when the Node worker is unreachable or
 * reports itself unhealthy. Vercel (`inline` for a small file, `after()`
 * otherwise) is the last resort after both of those. One attempt counter
 * covers every host. A row that stops making progress is marked failed so
 * the voice page stops waiting.
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
  | { action: "dispatch"; target: "node" | "cloudflare" | "vercel" }
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
 * Host order when the current attempt is stale: Node, then Cloudflare,
 * then Vercel, then fail. Node is retried once while its heartbeat is
 * dead. Cloudflare is re-sent once inside its window, and handed back to
 * Node only when Node has not already used two attempts. The last attempt
 * before the cap is Vercel. A legacy `extracting` row with no host is
 * handed to Node when Node is up, otherwise to Vercel once the window
 * elapses. One counter (`extract_attempts`) and the 20-minute accept cap
 * cover every host.
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

  if (host === "inline") {
    if (age < config.nodeHeartbeatStaleSeconds) return { action: "wait" };
    return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
  }

  if (host === "node") {
    if (age < config.nodeHeartbeatStaleSeconds) return { action: "wait" };
    // One Node retry, then Cloudflare, then Vercel on the attempt before the cap.
    if (input.nodeConfigured && attempts < 2) {
      return { action: "dispatch", target: "node" };
    }
    if (input.cfConfigured && attempts < config.maxAttempts - 1) {
      return { action: "dispatch", target: "cloudflare" };
    }
    if (attempts < config.maxAttempts) {
      return { action: "dispatch", target: "vercel" };
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
    if (attempts >= config.maxAttempts) {
      return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
    }
    if (input.nodeConfigured) return { action: "dispatch", target: "node" };
    if (input.cfConfigured) return { action: "dispatch", target: "cloudflare" };
    return { action: "dispatch", target: "vercel" };
  }

  // The previous Cloudflare worker never recorded a host. Send it to Node
  // when Node is up. Otherwise Vercel once the window elapses — the same
  // message and cap as every other host.
  if (input.status === "extracting" && !host) {
    if (input.nodeConfigured && attempts < config.maxAttempts) {
      return { action: "dispatch", target: "node" };
    }
    if (
      input.cfConfigured &&
      attempts < 2 &&
      age >= config.cfResendSeconds &&
      age < config.nodeHandoffSeconds
    ) {
      return { action: "dispatch", target: "cloudflare" };
    }
    if (age >= config.nodeHandoffSeconds || attempts >= 2) {
      if (attempts < config.maxAttempts) {
        return { action: "dispatch", target: "vercel" };
      }
      return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
    }
    return { action: "wait" };
  }

  if (host === "cloudflare") {
    if (age < config.cfResendSeconds) return { action: "wait" };
    if (
      input.cfConfigured &&
      attempts < 2 &&
      age < config.nodeHandoffSeconds
    ) {
      return { action: "dispatch", target: "cloudflare" };
    }
    if (age < config.nodeHandoffSeconds) return { action: "wait" };
    // Node again only when it has not already consumed two attempts.
    // Otherwise Vercel is the last host before the cap.
    if (
      input.nodeConfigured &&
      attempts < 3 &&
      attempts < config.maxAttempts - 1
    ) {
      return { action: "dispatch", target: "node" };
    }
    if (attempts < config.maxAttempts) {
      return { action: "dispatch", target: "vercel" };
    }
    return { action: "fail", message: EXTRACT_STUCK_MESSAGE };
  }

  return { action: "wait" };
}
