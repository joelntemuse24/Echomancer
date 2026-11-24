/**
 * A blip from Turso or the network. The worker should log it and try again.
 * A programming error is not transient: callers rethrow those.
 */

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Pause a worker loop this long after Turso answers `BLOCKED`. */
export const TURSO_QUOTA_BACKOFF_MS = 5 * 60_000;

const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

function statusOf(err: object): number | null {
  if ("status" in err && typeof err.status === "number" && Number.isFinite(err.status)) {
    return err.status;
  }
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  const match = message.match(/HTTP status (\d{3})/);
  return match ? Number(match[1]) : null;
}

/**
 * Turso has stopped serving reads (monthly rows-read quota). Retrying
 * immediately, or exiting so PM2 starts the process again, burns another
 * attempt every few seconds. Callers wait minutes instead.
 */
export function isTursoQuotaError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current && typeof current.code === "string" ? current.code : "";
    const message =
      "message" in current && typeof current.message === "string" ? current.message : "";
    if (
      code === "BLOCKED" ||
      /\bBLOCKED\b/.test(message) ||
      /SQL read operations are forbidden/i.test(message) ||
      /read(?:s| operations)? (?:are |is )?blocked/i.test(message)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * True when a worker loop should crash. Quota blocks and network blips
 * are paused instead: a quota error is not a 5s retry.
 */
export function isWorkerLoopFatal(err: unknown): boolean {
  return !isTransientWorkerError(err) && !isTursoQuotaError(err);
}

function transientNode(err: object): boolean {
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  if (TRANSIENT_CODES.has(code)) return true;
  const status = statusOf(err);
  if (status != null && TRANSIENT_STATUS.has(status)) return true;
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  if (/fetch failed|socket hang up|network (?:error|timeout)|timed out|bad gateway/i.test(message)) {
    return true;
  }
  return false;
}

/** Walk `cause` so a LibsqlError wrapping an HTTP 502 still counts. */
export function isTransientWorkerError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (transientNode(current)) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
