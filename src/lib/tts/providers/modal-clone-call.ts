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
 * until the deadline. A timeout (no HTTP status) that ends with no id is
 * `submit_unconfirmed`: the attempt does not move, and the next post of
 * that key reads the Dict. The section fails only after several empty
 * lookups. A completed HTTP 5xx is the control function answering, so the
 * spawn did not happen. Those retries stay inside the same deadline, then
 * the book fails. The synchronous GPU post is only for an unset URL, or a
 * body that names a different protocol.
 * A single-section `{text}` post stays on its own host.
 */

import { adoptFlightCall, rememberTrackedCall, remoteFlights } from "@/lib/remote/layer";

export const S2_CONTROL_PROTOCOL = "s2-submit-poll";

/** One accept. Matches the CPU function timeout, so a cold start can answer. */
export const S2_CONTROL_ACCEPT_MS = 20_000;
/** Retries of that accept. Past this the id is looked up, not invented. */
export const S2_CONTROL_DEADLINE_MS = 45_000;
/** One Dict read after the accept window. It does not spawn. */
export const S2_CONTROL_LOOKUP_MS = 8_000;
/**
 * Empty accepts with the same key. The section fails only after this many,
 * or after the wall budget, and only when the last lookup is still empty.
 */
export const UNCONFIRMED_SUBMIT_LIMIT = 3;
export const UNCONFIRMED_SUBMIT_WALL_MS = 3 * S2_CONTROL_DEADLINE_MS;
/**
 * After the one same-key resubmit, NotFound may continue for the render
 * wait plus this margin. Past that the flight is terminal, like `expired`.
 */
export const S2_NOT_FOUND_MARGIN_MS = 30_000;
/**
 * Reconcile's backstop for a flight left still_live. One observation starts
 * the clock; a later pass past the warm render wait plus the margin settles it.
 */
export const S2_NOT_FOUND_RECONCILE_MS = 400_000 + S2_NOT_FOUND_MARGIN_MS;
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
let acceptDeadlineForTests: number | null = null;
let notFoundMarginForTests: number | null = null;
let statusReaderForTests:
  | ((callId: string) => Promise<{ status?: string | null; error?: string | null }>)
  | null = null;
let keyLookupForTests: ((key: string) => Promise<string | null>) | null = null;
const unconfirmedSubmits = new Map<string, { count: number; since: number }>();
const unresolvedKeys = new Set<string>();

/** Shorten the poll budget. Production uses the call's own wait. */
export function setS2StatusBudgetForTests(ms: number | null): void {
  statusBudgetForTests = ms;
}

/** Shorten the 45s accept window. Production always uses {@link S2_CONTROL_DEADLINE_MS}. */
export function setS2AcceptDeadlineForTests(ms: number | null): void {
  acceptDeadlineForTests = ms;
}

/** Reconcile tests report a stored id's status without an HTTP call. */
export function setS2StatusReaderForTests(
  fn: ((callId: string) => Promise<{ status?: string | null; error?: string | null }>) | null
): void {
  statusReaderForTests = fn;
}

/** Tests answer a Dict lookup without an HTTP call. */
export function setS2KeyLookupForTests(
  fn: ((key: string) => Promise<string | null>) | null
): void {
  keyLookupForTests = fn;
}

/** Override the post-budget NotFound margin. `0` settles as soon as the wait ends. */
export function setS2NotFoundMarginForTests(ms: number | null): void {
  notFoundMarginForTests = ms;
}

export function resetS2ControlForTests(): void {
  statusBudgetForTests = null;
  acceptDeadlineForTests = null;
  notFoundMarginForTests = null;
  statusReaderForTests = null;
  keyLookupForTests = null;
  unconfirmedSubmits.clear();
  unresolvedKeys.clear();
}

function notFoundMarginMs(): number {
  if (notFoundMarginForTests != null) return Math.max(0, notFoundMarginForTests);
  if (statusBudgetForTests != null) return 0;
  return S2_NOT_FOUND_MARGIN_MS;
}

/**
 * One empty accept for this key. `giveUp` is the bound: the caller has
 * already looked the key up and found no id.
 */
export function noteSubmitUnconfirmed(
  key: string,
  now = Date.now()
): { count: number; giveUp: boolean } {
  const id = key.trim();
  const prev = id ? unconfirmedSubmits.get(id) : undefined;
  const since = prev?.since ?? now;
  const count = (prev?.count ?? 0) + 1;
  if (id) unconfirmedSubmits.set(id, { count, since });
  const giveUp = count >= UNCONFIRMED_SUBMIT_LIMIT || now - since >= UNCONFIRMED_SUBMIT_WALL_MS;
  return { count, giveUp };
}

export function clearSubmitUnconfirmed(key: string): void {
  const id = key.trim();
  if (id) unconfirmedSubmits.delete(id);
}

/** A bounded miss whose Dict row may still appear. Reconcile reads these. */
export function noteUnresolvedS2Key(key: string): void {
  const id = key.trim();
  if (id) unresolvedKeys.add(id);
}

export function forgetUnresolvedS2Key(key: string): void {
  unresolvedKeys.delete(key.trim());
}

export function unresolvedS2Keys(): string[] {
  return [...unresolvedKeys];
}

/**
 * The accept window ended with no id.
 * `giveUp` is set only after the bound and an empty same-key lookup.
 * Until then the attempt must not move.
 */
export class S2ControlUnavailable extends Error {
  readonly giveUp: boolean;
  constructor(giveUp = false) {
    super(
      giveUp
        ? "Modal control did not accept the book"
        : "Modal control accept was not confirmed"
    );
    this.name = "S2ControlUnavailable";
    this.giveUp = giveUp;
  }
}

/**
 * The control function answered HTTP 5xx for the whole accept window and
 * the Dict has no call id. The spawn did not happen. This is not
 * {@link S2ControlUnavailable}: that one is a lost response, and retrying
 * it keeps the book on "Starting the clone voice…".
 */
export class S2ControlRejected extends Error {
  readonly status: number;
  constructor(detail: string, status: number) {
    super(detail);
    this.name = "S2ControlRejected";
    this.status = status;
  }
}

/**
 * NotFound lasted through the render wait and the margin, after the one
 * same-key resubmit. The flight is terminal. The attempt does not move.
 */
export class S2NotFoundSettled extends Error {
  readonly callId: string;
  constructor(callId: string) {
    super(`Modal clone call ${callId} was not published`);
    this.name = "S2NotFoundSettled";
    this.callId = callId;
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

export type S2FleetAction = "read" | "brake" | "restore" | "count";

export type S2FleetResult = {
  maxContainers: number | null;
  running: number | null;
  source: string;
  app: string;
};

/**
 * Read, brake, restore, or count on the deployed S2 app.
 *
 * The body names the action. It does not name an app: the control container
 * uses the identity it was deployed with, so a worker cannot brake staging
 * by sending a different name. The same bearer as submit and cancel.
 */
export async function s2Fleet(
  action: S2FleetAction,
  maxContainers?: number
): Promise<S2FleetResult> {
  const origin = s2ControlOrigin();
  if (!origin) throw new Error("MODAL_S2_CONTROL_URL is not configured");
  const body: Record<string, unknown> = { autoscaler: action };
  if (action === "restore") {
    if (!Number.isInteger(maxContainers) || (maxContainers ?? 0) < 1) {
      throw new Error("restore needs max_containers");
    }
    body.max_containers = maxContainers;
  }
  const response = await fetch(origin, {
    method: "POST",
    headers: callHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    const json = JSON.parse(text) as unknown;
    if (json && typeof json === "object") parsed = json as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const detail = parsed.detail;
    const message =
      detail && typeof detail === "object"
        ? JSON.stringify(detail)
        : text.trim() || `s2 control ${response.status}`;
    throw new Error(message);
  }
  const max = parsed.max_containers;
  const running = parsed.running;
  return {
    maxContainers: typeof max === "number" && Number.isInteger(max) && max >= 0 ? max : null,
    running: typeof running === "number" && Number.isInteger(running) && running >= 0 ? running : null,
    source: typeof parsed.source === "string" ? parsed.source : "",
    app: typeof parsed.app === "string" ? parsed.app : "",
  };
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
  | { kind: "rejected"; status: number; message: string }
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
 * One accept. A thrown fetch (no status) is `retry`: the container may
 * still be starting and the spawn may have landed. A completed HTTP 5xx
 * is `rejected`: the function answered, so this spawn did not. A named
 * protocol that is not this one is a positive mismatch.
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
  if (!submit.ok && submit.status >= 500) {
    const detail =
      (typeof data?.detail === "string" && data.detail.trim()) ||
      (typeof data?.error === "string" && data.error.trim()) ||
      text.trim().slice(0, 300) ||
      `s2 control HTTP ${submit.status}`;
    return { kind: "rejected", status: submit.status, message: detail };
  }
  return { kind: "retry" };
}

function missError(callId: string, status: string): Error {
  return Object.assign(new Error(`Modal clone call ${callId} ended ${status}`), {
    name: "S2CallMiss",
    s2Status: status,
  });
}

function idempotencyKeyOf(body: Record<string, unknown>): string {
  return typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
}

function notPublished(status: string, error: string): boolean {
  return status === "not_found" || error === "not_published";
}

/**
 * Read the Dict for this key. This posts `{lookup:true}` and never spawns.
 * A transport miss is an empty row, not a new call.
 */
export async function lookupS2IdempotencyKey(
  key: string,
  opts?: { url?: string; headers?: Record<string, string>; signal?: AbortSignal }
): Promise<string | null> {
  const id = key.trim();
  if (!id) return null;
  if (keyLookupForTests) return keyLookupForTests(id);
  const origin = opts?.url || s2ControlOrigin();
  if (!origin) return null;
  let headers: Record<string, string>;
  try {
    headers = opts?.headers ?? callHeaders();
  } catch {
    return null;
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), S2_CONTROL_LOOKUP_MS);
  const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetch(origin, {
      method: "POST",
      headers,
      body: JSON.stringify({ lookup: true, idempotency_key: id }),
      signal,
    });
    const data = parseJson(await response.text());
    if (!response.ok || !data || data.status === "absent") return null;
    const callId = typeof data.call_id === "string" ? data.call_id.trim() : "";
    return callId || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flights and give-up keys that have no stored id. A Dict hit is written
 * onto the flight, or remembered beside a later attempt, so drain and
 * reconcile can cancel it.
 */
export async function resolveOpenS2Keys(jobId?: string): Promise<number> {
  let adopted = 0;
  for (const flight of remoteFlights()) {
    if (flight.provider !== "s2-clone" || flight.callId) continue;
    if (jobId && flight.jobId !== jobId) continue;
    if (
      flight.status !== "submit_unconfirmed" &&
      flight.status !== "running" &&
      flight.status !== "still_live" &&
      flight.status !== "failure"
    ) {
      continue;
    }
    const found = await lookupS2IdempotencyKey(flight.idempotencyKey);
    if (!found) continue;
    if (adoptFlightCall(flight.idempotencyKey, found)) {
      clearSubmitUnconfirmed(flight.idempotencyKey);
      forgetUnresolvedS2Key(flight.idempotencyKey);
      adopted += 1;
    }
  }
  for (const key of unresolvedS2Keys()) {
    const owner = key.split(":")[0] ?? "";
    if (jobId && owner !== jobId) continue;
    const found = await lookupS2IdempotencyKey(key);
    if (!found) continue;
    const sections = (key.split(":")[1] ?? "").split(",").filter(Boolean);
    if (!adoptFlightCall(key, found)) {
      rememberTrackedCall({
        idempotencyKey: key,
        callId: found,
        jobId: owner || undefined,
        sections,
      });
    }
    clearSubmitUnconfirmed(key);
    forgetUnresolvedS2Key(key);
    adopted += 1;
  }
  return adopted;
}

export async function submitThenPoll(opts: {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  signal: AbortSignal;
  waitMs: number;
  onCallId: (callId: string) => void;
}): Promise<Response> {
  const acceptUntil = Date.now() + (acceptDeadlineForTests ?? S2_CONTROL_DEADLINE_MS);
  const key = idempotencyKeyOf(opts.body);
  let callId = "";
  let rejected: { status: number; message: string } | null = null;

  const recoverCallId = async (): Promise<string> => {
    const found = key
      ? await lookupS2IdempotencyKey(key, {
          url: opts.url,
          headers: opts.headers,
          signal: opts.signal,
        })
      : null;
    if (opts.signal.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    if (found) {
      if (key) clearSubmitUnconfirmed(key);
      if (key) forgetUnresolvedS2Key(key);
      return found;
    }
    const note = noteSubmitUnconfirmed(key || opts.url);
    if (note.giveUp && key) noteUnresolvedS2Key(key);
    throw new S2ControlUnavailable(note.giveUp);
  };

  const finishAccept = async (): Promise<string> => {
    if (!rejected) return recoverCallId();
    const found = key
      ? await lookupS2IdempotencyKey(key, {
          url: opts.url,
          headers: opts.headers,
          signal: opts.signal,
        })
      : null;
    if (opts.signal.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    if (found) {
      if (key) clearSubmitUnconfirmed(key);
      if (key) forgetUnresolvedS2Key(key);
      return found;
    }
    // A completed 5xx stored nothing. Do not count it as an unconfirmed
    // accept: that left the book processing with no section, and the
    // player stayed on "Starting the clone voice…" (observed 4m26s).
    throw new S2ControlRejected(rejected.message, rejected.status);
  };

  while (!callId) {
    if (opts.signal.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const remaining = acceptUntil - Date.now();
    if (remaining <= 0) {
      callId = await finishAccept();
      opts.onCallId(callId);
      break;
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
      if (wait <= 0) {
        callId = await finishAccept();
        opts.onCallId(callId);
        break;
      }
      await sleep(wait, opts.signal);
      continue;
    }
    if (hit.kind === "audio") return hit.response;
    if (hit.kind === "protocol") throw new S2ProtocolMismatch(hit.protocol);
    if (hit.kind === "call") {
      callId = hit.callId;
      if (key) clearSubmitUnconfirmed(key);
      if (key) forgetUnresolvedS2Key(key);
      // Persist before any poll. A timeout after this still has an id to cancel.
      opts.onCallId(callId);
      break;
    }
    if (hit.kind === "rejected") {
      rejected = { status: hit.status, message: hit.message };
    }
    const wait = Math.min(CONTROL_BACKOFF_MS, acceptUntil - Date.now());
    if (wait <= 0) {
      callId = await finishAccept();
      opts.onCallId(callId);
      break;
    }
    await sleep(wait, opts.signal);
  }

  const budget = statusBudgetForTests ?? opts.waitMs;
  let deadline = Date.now() + budget;
  let notFoundResubmits = 0;
  let sawNotPublished = false;
  let extended = false;
  while (true) {
    if (Date.now() >= deadline) {
      if (sawNotPublished && notFoundResubmits >= NOT_FOUND_RESUBMITS && !extended) {
        const margin = notFoundMarginMs();
        extended = true;
        if (margin > 0) {
          deadline = Date.now() + margin;
          continue;
        }
      }
      break;
    }
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
      if (Date.now() >= deadline) continue;
      await sleep(Math.min(POLL_GAP_MS, deadline - Date.now()), opts.signal);
      continue;
    } finally {
      clearTimeout(pollTimer);
    }
    const data = parseJson(await poll.text());
    const status = typeof data?.status === "string" ? data.status : "";
    const error = typeof data?.error === "string" ? data.error : "";
    // NotFound can be raised while the input is still pending. Poll the
    // stored id, and one resubmit uses the same idempotency key so the
    // server returns that id instead of spawning. The server reports that
    // miss as `unknown` plus `error: not_published`.
    if (notPublished(status, error) && notFoundResubmits < NOT_FOUND_RESUBMITS) {
      sawNotPublished = true;
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
    if (notPublished(status, error)) sawNotPublished = true;
    if (
      !poll.ok ||
      !data ||
      status === "pending" ||
      status === "unknown" ||
      status === "not_found" ||
      !status
    ) {
      if (Date.now() >= deadline) continue;
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
      if (Date.now() >= deadline) continue;
      await sleep(Math.min(POLL_GAP_MS, Math.max(0, deadline - Date.now())), opts.signal);
      continue;
    }
    if (isTerminalS2Status(status)) {
      throw missError(callId, status);
    }
    if (Date.now() >= deadline) continue;
    await sleep(Math.min(POLL_GAP_MS, Math.max(0, deadline - Date.now())), opts.signal);
  }
  if (sawNotPublished && notFoundResubmits >= NOT_FOUND_RESUBMITS) {
    throw new S2NotFoundSettled(callId);
  }
  throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
}

/**
 * Read one stored id. A transport problem is `unknown` (still live).
 * NotFound arrives as `unknown` with `error: not_published` and stays
 * live until the render wait plus the margin. `expired` is terminal.
 */
export async function pollS2Call(callId: string): Promise<{ status: string; error?: string }> {
  if (statusReaderForTests) {
    const read = await statusReaderForTests(callId);
    const status = typeof read.status === "string" && read.status ? read.status : "unknown";
    const error = typeof read.error === "string" ? read.error : "";
    return error ? { status, error } : { status };
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
    const parsed = parseJson(text);
    if (!parsed) return { status: "unknown" };
    const status = typeof parsed.status === "string" && parsed.status ? parsed.status : "unknown";
    const error = typeof parsed.error === "string" ? parsed.error : "";
    return error ? { status, error } : { status };
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
