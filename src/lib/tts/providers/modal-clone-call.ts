/**
 * Book-path submit, poll, and cancel for one S2 FunctionCall.
 *
 * The CPU control endpoint returns `{call_id, status:"pending"}` as soon as
 * it has spawned. The id is handed to `onCallId` before any poll. Stop and
 * the drain cancel that id with `{cancel:true}` on the same host. No CLI,
 * no profile.
 *
 * A batch body uses that endpoint whenever `MODAL_S2_CONTROL_URL` is set.
 * A cold start is a slow accept: the same idempotency key is posted again
 * until the deadline, and the section fails if the id never arrives. The
 * synchronous GPU post is only for an unset URL, or a body that names a
 * different protocol. A single-section `{text}` post stays on its own host.
 */

export const S2_CONTROL_PROTOCOL = "s2-submit-poll";

/** One accept. Matches the CPU function timeout, so a cold start can answer. */
export const S2_CONTROL_ACCEPT_MS = 20_000;
/** Retries of that accept. Past this the section fails; the GPU is not posted. */
export const S2_CONTROL_DEADLINE_MS = 45_000;
const CONTROL_BACKOFF_MS = 2_000;
const POLL_ATTEMPT_MS = 5_000;
const POLL_GAP_MS = 2_000;
const NOT_FOUND_RESUBMITS = 1;

const TERMINAL_S2_STATUS = new Set([
  "success",
  "failure",
  "cancelled",
  "canceled",
  "expired",
  "terminated",
  "timeout",
  "init_failure",
  "init failure",
]);

let statusBudgetForTests: number | null = null;
let statusReaderForTests: ((callId: string) => Promise<{ status?: string | null }>) | null = null;

/** Shorten the poll budget. Production uses the call's own wait. */
export function setS2StatusBudgetForTests(ms: number | null): void {
  statusBudgetForTests = ms;
}

/** Reconcile tests report a stored id's status without an HTTP call. */
export function setS2StatusReaderForTests(
  fn: ((callId: string) => Promise<{ status?: string | null }>) | null
): void {
  statusReaderForTests = fn;
}

export function resetS2ControlForTests(): void {
  statusBudgetForTests = null;
  statusReaderForTests = null;
}

/** The control host did not accept the book before the deadline. */
export class S2ControlUnavailable extends Error {
  constructor(message = "Modal control did not accept the book") {
    super(message);
    this.name = "S2ControlUnavailable";
  }
}

/** The control host named a protocol this worker does not speak. */
export class S2ProtocolMismatch extends Error {
  readonly protocol: string;
  constructor(protocol: string) {
    super(`S2 control protocol ${protocol}`);
    this.name = "S2ProtocolMismatch";
    this.protocol = protocol;
  }
}

export function isTerminalS2Status(status: string | null | undefined): boolean {
  return TERMINAL_S2_STATUS.has(String(status ?? "").trim().toLowerCase());
}

/** `job:sections:attempt`. The control endpoint stores the call id under this. */
export function s2IdempotencyKey(jobId: string, sections: string[], epoch: number): string {
  const keys = [...sections].map(String).filter(Boolean).sort().join(",");
  return `${jobId}:${keys}:${Math.max(0, Math.floor(epoch))}`;
}

export function s2ControlOrigin(): string | null {
  const raw = process.env.MODAL_S2_CONTROL_URL?.trim();
  if (!raw) return null;
  let control: string;
  try {
    control = new URL(raw).origin;
  } catch {
    return null;
  }
  const batch = process.env.MODAL_S2_TTS_URL?.trim();
  if (batch) {
    try {
      if (new URL(batch).origin === control) return null;
    } catch {
      /* a bad batch URL does not make the control host a GPU */
    }
  }
  return control;
}

function callHeaders(): Record<string, string> {
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  return {
    Authorization: `Bearer ${token}`,
    "x-echomancer-token": token,
    "Content-Type": "application/json",
  };
}

function withCallId(url: string, callId: string): string {
  const next = new URL(url);
  next.searchParams.set("call_id", callId);
  return next.toString();
}

function replay(response: Response, text: string): Response {
  return new Response(text, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

type SubmitHit =
  | { kind: "audio"; response: Response }
  | { kind: "call"; callId: string }
  | { kind: "protocol"; protocol: string }
  | { kind: "retry" };

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function differentProtocol(data: Record<string, unknown> | null): string | null {
  const protocol = data?.protocol;
  if (typeof protocol !== "string") return null;
  const named = protocol.trim();
  if (!named || named === S2_CONTROL_PROTOCOL) return null;
  return named;
}

/**
 * One accept. A timeout or a 5xx is `retry` (the container is still
 * starting). A named protocol that is not this one is a positive mismatch.
 */
async function postSubmit(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal,
  acceptMs: number
): Promise<SubmitHit> {
  const submitTimeout = new AbortController();
  const submitTimer = setTimeout(() => submitTimeout.abort(), Math.max(1, acceptMs));
  let submit: Response;
  try {
    submit = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, submitTimeout.signal]),
    });
  } finally {
    clearTimeout(submitTimer);
  }
  const text = await submit.text();
  const data = parseJson(text);
  if (data && Array.isArray(data.items)) return { kind: "audio", response: replay(submit, text) };
  const named = differentProtocol(data);
  if (named && !data?.call_id) return { kind: "protocol", protocol: named };
  const callId = typeof data?.call_id === "string" ? data.call_id.trim() : "";
  if (submit.ok && callId) return { kind: "call", callId };
  return { kind: "retry" };
}

function missError(callId: string, status: string): Error {
  return Object.assign(new Error(`Modal clone call ${callId} ended ${status}`), {
    name: "S2CallMiss",
    s2Status: status,
  });
}

export async function submitThenPoll(opts: {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal: AbortSignal;
  waitMs: number;
  onCallId: (callId: string) => void;
}): Promise<Response> {
  const acceptUntil = Date.now() + S2_CONTROL_DEADLINE_MS;
  let callId = "";
  while (!callId) {
    if (opts.signal.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const remaining = acceptUntil - Date.now();
    if (remaining <= 0) {
      throw new S2ControlUnavailable();
    }
    let hit: SubmitHit;
    try {
      hit = await postSubmit(
        opts.url,
        opts.body,
        opts.headers,
        opts.signal,
        Math.min(S2_CONTROL_ACCEPT_MS, remaining)
      );
    } catch (err) {
      if (opts.signal.aborted) throw err;
      const wait = Math.min(CONTROL_BACKOFF_MS, acceptUntil - Date.now());
      if (wait <= 0) throw new S2ControlUnavailable();
      await sleep(wait, opts.signal);
      continue;
    }
    if (hit.kind === "audio") return hit.response;
    if (hit.kind === "protocol") throw new S2ProtocolMismatch(hit.protocol);
    if (hit.kind === "call") {
      callId = hit.callId;
      // Persist before any poll. A timeout after this still has an id to cancel.
      opts.onCallId(callId);
      break;
    }
    const wait = Math.min(CONTROL_BACKOFF_MS, acceptUntil - Date.now());
    if (wait <= 0) throw new S2ControlUnavailable();
    await sleep(wait, opts.signal);
  }

  const budget = statusBudgetForTests ?? opts.waitMs;
  const deadline = Date.now() + budget;
  let notFoundResubmits = 0;
  while (Date.now() < deadline) {
    if (opts.signal.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const remaining = deadline - Date.now();
    const pollTimeout = new AbortController();
    const pollTimer = setTimeout(
      () => pollTimeout.abort(),
      Math.max(1, Math.min(POLL_ATTEMPT_MS, remaining))
    );
    let poll: Response;
    try {
      poll = await fetch(withCallId(opts.url, callId), {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify({ call_id: callId }),
        signal: AbortSignal.any([opts.signal, pollTimeout.signal]),
      });
    } catch (err) {
      if (opts.signal.aborted) throw err;
      // A dropped poll is unknown. It is not a failure, and it is not a new submit.
      if (Date.now() >= deadline) break;
      await sleep(Math.min(POLL_GAP_MS, deadline - Date.now()), opts.signal);
      continue;
    } finally {
      clearTimeout(pollTimer);
    }
    const data = parseJson(await poll.text());
    const status = typeof data?.status === "string" ? data.status : "";
    // NotFound can be raised while the input is still pending. Poll the
    // stored id, and one resubmit uses the same idempotency key so the
    // server returns that id instead of spawning.
    if (status === "not_found" && notFoundResubmits < NOT_FOUND_RESUBMITS) {
      notFoundResubmits += 1;
      try {
        const again = await postSubmit(
          opts.url,
          opts.body,
          opts.headers,
          opts.signal,
          Math.min(S2_CONTROL_ACCEPT_MS, Math.max(1, deadline - Date.now()))
        );
        if (again.kind === "audio") return again.response;
        if (again.kind === "call") {
          callId = again.callId;
          opts.onCallId(callId);
        }
      } catch (err) {
        if (opts.signal.aborted) throw err;
      }
      continue;
    }
    if (
      !poll.ok ||
      !data ||
      status === "pending" ||
      status === "unknown" ||
      status === "not_found" ||
      !status
    ) {
      if (Date.now() >= deadline) break;
      await sleep(Math.min(POLL_GAP_MS, Math.max(0, deadline - Date.now())), opts.signal);
      continue;
    }
    if (status === "success" && data.result && typeof data.result === "object" && !Array.isArray(data.result)) {
      return new Response(JSON.stringify(data.result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (status === "success") {
      // A success that is not a JSON object is the bytes bug. Keep the id.
      if (Date.now() >= deadline) break;
      await sleep(Math.min(POLL_GAP_MS, Math.max(0, deadline - Date.now())), opts.signal);
      continue;
    }
    if (isTerminalS2Status(status)) {
      throw missError(callId, status);
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_GAP_MS, Math.max(0, deadline - Date.now())), opts.signal);
  }
  throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
}

/**
 * Read one stored id. A transport problem, or NotFound while the input
 * may still be pending, is `unknown` (still live). `expired` is terminal.
 */
export async function pollS2Call(callId: string): Promise<{ status: string }> {
  if (statusReaderForTests) {
    const read = await statusReaderForTests(callId);
    return { status: typeof read.status === "string" ? read.status : "unknown" };
  }
  const origin = s2ControlOrigin();
  if (!origin || !process.env.MODAL_S2_TOKEN?.trim()) return { status: "unknown" };
  try {
    const response = await fetch(withCallId(origin, callId), {
      method: "POST",
      headers: callHeaders(),
      body: JSON.stringify({ call_id: callId }),
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    if (!response.ok) return { status: "unknown" };
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return { status: "unknown" };
    const status = (parsed as { status?: unknown }).status;
    return { status: typeof status === "string" && status ? status : "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Cancel one stored FunctionCall, then use the status the server re-read.
 * `pending` and `not_found` are not terminal. `expired` is.
 */
export async function cancelS2Call(callId: string): Promise<{
  status?: string | null;
  threw?: string | null;
}> {
  const origin = s2ControlOrigin();
  if (!origin) return { status: "pending", threw: "MODAL_S2_CONTROL_URL is not configured" };
  const response = await fetch(withCallId(origin, callId), {
    method: "POST",
    headers: callHeaders(),
    body: JSON.stringify({ call_id: callId, cancel: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  const status = typeof data.status === "string" ? data.status : "";
  const error = typeof data.error === "string" ? data.error : "";
  if (isTerminalS2Status(status)) return { status, threw: error || null };
  if (!response.ok && !status) {
    return { status: "pending", threw: text.trim() || `HTTP ${response.status}` };
  }
  return { status: status || "pending", threw: error || null };
}
