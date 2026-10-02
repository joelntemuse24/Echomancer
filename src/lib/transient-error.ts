/**
 * A blip from Turso or the network. The worker should log it and try again.
 * A programming error is not transient: callers rethrow those.
 */

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

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
