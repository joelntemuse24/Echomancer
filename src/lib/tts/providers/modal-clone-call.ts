/**
 * Book-path submit, poll, and cancel for one S2 FunctionCall.
 *
 * The CPU control endpoint returns `{call_id, status:"pending"}` as soon as
 * it has spawned. The id is handed to `onCallId` before any poll. Stop and
 * the drain cancel that id with `{cancel:true}` on the same host. No CLI,
 * no profile.
 *
 * When that endpoint is not deployed, `s2BookTransport` is `sync` and the
 * caller posts the book to the GPU endpoint with the long timeout.
 */

export const S2_CONTROL_PROTOCOL = "s2-submit-poll";

const SUBMIT_MS = 10_000;
const POLL_ATTEMPT_MS = 5_000;
const POLL_GAP_MS = 2_000;
const PROBE_MS = 3_000;
const PROTOCOL_HOLD_MS = 60_000;
const PROTOCOL_MISS_MS = 5_000;

const TERMINAL_S2_STATUS = new Set([
  "success",
  "failure",
  "cancelled",
  "canceled",
  "expired",
  "not_found",
  "terminated",
  "timeout",
  "init_failure",
  "init failure",
]);

let statusBudgetForTests: number | null = null;
let protocolCache: { at: number; mode: "submit-poll" | "sync"; until: number } | null = null;
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
  protocolCache = null;
  statusReaderForTests = null;
}

export function isTerminalS2Status(status: string | null | undefined): boolean {
  return TERMINAL_S2_STATUS.has(String(status ?? "").trim().toLowerCase());
}

/** `job:sections:attempt`. The control endpoint stores the call id under this. */
export function s2IdempotencyKey(jobId: string, sections: string[], epoch: number): string {
  const keys = [...sections].map(String).filter(Boolean).sort().join(",");
  return `${jobId}:${keys}:${Math.max(0, Math.floor(epoch))}`;
}

function controlOrigin(): string | null {
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

function rememberProtocol(mode: "submit-poll" | "sync"): void {
  const hold = mode === "submit-poll" ? PROTOCOL_HOLD_MS : PROTOCOL_MISS_MS;
  protocolCache = { at: Date.now(), mode, until: Date.now() + hold };
}

/**
 * `submit-poll` only when the CPU control endpoint names this protocol.
 * Anything else, including a missing URL, is the synchronous GPU post.
 */
export async function s2BookTransport(signal?: AbortSignal): Promise<"submit-poll" | "sync"> {
  if (protocolCache && Date.now() < protocolCache.until) return protocolCache.mode;
  const url = controlOrigin();
  if (!url || !process.env.MODAL_S2_TOKEN?.trim()) {
    rememberProtocol("sync");
    return "sync";
  }
  const probeTimeout = new AbortController();
  const timer = setTimeout(() => probeTimeout.abort(), PROBE_MS);
  const signals = [probeTimeout.signal];
  if (signal) signals.push(signal);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: callHeaders(),
      body: JSON.stringify({ probe: true }),
      signal: AbortSignal.any(signals),
    });
    const text = await response.text();
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      data = null;
    }
    const version = Number(data?.protocol_version ?? 0);
    const mode =
      response.ok && data?.protocol === S2_CONTROL_PROTOCOL && version >= 1
        ? "submit-poll"
        : "sync";
    rememberProtocol(mode);
    return mode;
  } catch (err) {
    if (signal?.aborted) throw err;
    rememberProtocol("sync");
    return "sync";
  } finally {
    clearTimeout(timer);
  }
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
  const submitTimeout = new AbortController();
  const submitTimer = setTimeout(() => submitTimeout.abort(), SUBMIT_MS);
  const submitSignal = AbortSignal.any([opts.signal, submitTimeout.signal]);
  let submit: Response;
  try {
    submit = await fetch(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: submitSignal,
    });
  } finally {
    clearTimeout(submitTimer);
  }
  const submitText = await submit.text();
  let submitJson: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(submitText) as unknown;
    if (parsed && typeof parsed === "object") submitJson = parsed as Record<string, unknown>;
  } catch {
    submitJson = null;
  }
  // An old container that finished inside the accept window returns the audio.
  if (submitJson && Array.isArray(submitJson.items)) {
    return replay(submit, submitText);
  }
  const callId = typeof submitJson?.call_id === "string" ? submitJson.call_id.trim() : "";
  if (!submit.ok || !callId) return replay(submit, submitText);
  // Persist before any poll. A timeout after this still has an id to cancel.
  opts.onCallId(callId);

  const budget = statusBudgetForTests ?? opts.waitMs;
  const deadline = Date.now() + budget;
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
    const pollText = await poll.text();
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(pollText) as unknown;
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      data = null;
    }
    const status = typeof data?.status === "string" ? data.status : "";
    if (!poll.ok || !data || status === "pending" || status === "unknown" || !status) {
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
 * Read one stored id. A transport problem is `unknown` (still live).
 * `expired` and `not_found` are terminal misses.
 */
export async function pollS2Call(callId: string): Promise<{ status: string }> {
  if (statusReaderForTests) {
    const read = await statusReaderForTests(callId);
    return { status: typeof read.status === "string" ? read.status : "unknown" };
  }
  const origin = controlOrigin();
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
 * `pending` is not terminal. `expired` and `not_found` are.
 */
export async function cancelS2Call(callId: string): Promise<{
  status?: string | null;
  threw?: string | null;
}> {
  const origin = controlOrigin();
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
