/**
 * Book-path submit, poll, and cancel for one S2 FunctionCall.
 *
 * The web endpoint returns `{call_id, status:"pending"}` as soon as it has
 * spawned. The id is handed to `onCallId` before any poll. Stop and the drain
 * cancel that id with `{cancel:true}` on the same host. No CLI, no profile.
 */

const SUBMIT_MS = 10_000;
const POLL_ATTEMPT_MS = 5_000;
const POLL_GAP_MS = 2_000;

let statusBudgetForTests: number | null = null;

/** Shorten the poll budget. Production uses the call's own wait. */
export function setS2StatusBudgetForTests(ms: number | null): void {
  statusBudgetForTests = ms;
}

function batchOrigin(): string {
  const raw = process.env.MODAL_S2_TTS_URL?.trim();
  if (!raw) throw new Error("MODAL_S2_TTS_URL is not configured");
  return new URL(raw).origin;
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

function errorNamed(err: unknown): string {
  return err instanceof Error ? err.name : "";
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
      const attemptTimedOut =
        pollTimeout.signal.aborted || errorNamed(err) === "TimeoutError";
      if (attemptTimedOut) {
        if (Date.now() >= deadline) {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        }
        await sleep(Math.min(POLL_GAP_MS, deadline - Date.now()), opts.signal);
        continue;
      }
      throw err;
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
    if (!poll.ok || !data) return replay(poll, pollText);
    if (data.status === "pending") {
      await sleep(Math.min(POLL_GAP_MS, deadline - Date.now()), opts.signal);
      continue;
    }
    if (data.status === "success" && data.result && typeof data.result === "object") {
      return new Response(JSON.stringify(data.result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const failed = data.status === "cancelled" || data.status === "failure";
    return new Response(pollText, {
      status: failed ? 502 : poll.status,
      headers: { "content-type": "application/json" },
    });
  }
  throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
}

/**
 * Cancel one stored FunctionCall. `{status:"pending"}` with `threw` is not
 * terminal (including NotFound). `cancelled` / `terminated` / `success` are.
 */
export async function cancelS2Call(callId: string): Promise<{
  status?: string | null;
  threw?: string | null;
}> {
  const response = await fetch(withCallId(batchOrigin(), callId), {
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
  if (!response.ok && !status) return { status: "pending", threw: text.trim() || `HTTP ${response.status}` };
  if (status === "pending" || /notfound|not found/i.test(error)) {
    return { status: "pending", threw: error || status || "pending" };
  }
  return { status: status || (response.ok ? "terminated" : "pending") };
}
