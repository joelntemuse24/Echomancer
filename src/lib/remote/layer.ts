/**
 * Shared remote-call layer.
 *
 * Every paid path (S2 clone GPU, Fish, Kokoro CPU, Modal CPU, previews,
 * prewarm) admits work here. The layer owns:
 *
 * - single-flight per (provider, book, section): a second start joins the
 *   running promise, or is refused while the remote call is still live
 * - idempotency keys
 * - per-path timeouts (the caller may also arm its own clock)
 * - cancel verification: NotFound and any non-terminal status are still live
 * - cost and time budgets per book and per day (enforced outside Vitest,
 *   and whenever a caller passes caps)
 * - a structured event log
 *
 * Cancellation, worker restart, and the daily health check all read the
 * same flights. Nothing here dials Modal, Fish, or a GPU.
 */

import { RemoteCallRefused, type RemoteEvent, type RemoteOutcome, type RemotePath, type RemoteProvider } from "@/lib/remote/types";

export type { RemoteEvent, RemoteOutcome, RemotePath, RemoteProvider } from "@/lib/remote/types";
export { RemoteCallRefused } from "@/lib/remote/types";

const TERMINAL = new Set<RemoteOutcome>(["success", "failure", "cancelled", "timeout"]);

export function isTerminalOutcome(outcome: RemoteOutcome): boolean {
  return TERMINAL.has(outcome);
}

export type FlightStatus = "running" | "still_live" | "success" | "failure" | "cancelled" | "timeout";

export type Flight = {
  key: string;
  idempotencyKey: string;
  provider: RemoteProvider;
  path: RemotePath;
  jobId?: string;
  sections: string[];
  status: FlightStatus;
  promise?: Promise<unknown>;
  abort?: () => void;
  callId?: string;
  /** `echo:<job>:<sections>:<nonce>` sent on the request so a listing can find it. */
  tag?: string;
  startedAt: number;
  endedAt?: number;
  estCostUsd: number;
  estMs: number;
};

export type AdmitInput = {
  provider: RemoteProvider;
  path: RemotePath;
  jobId?: string;
  /** Section indexes or keys this call owns. Empty means the whole book. */
  sections?: string[];
  idempotencyKey?: string;
  callId?: string;
  estCostUsd?: number;
  estMs?: number;
  now?: number;
};

type BudgetCaps = {
  bookUsd: number;
  dailyUsd: number;
  bookMs: number;
  dailyMs: number;
};

const flights = new Map<string, Flight>();
const events: RemoteEvent[] = [];
const halted = new Map<string, string>();
const drainRequests = new Set<string>();
let seq = 0;
let eventSink: ((event: RemoteEvent) => void) | null = null;
let stampSink: ((flight: Flight) => void) | null = null;

/** Dollar reservations from `started` rows. Wall time is the merged span. */
export type SpendRow = {
  key: string;
  jobId?: string;
  usd: number;
  start: number;
  end: number;
};

let spend: SpendRow[] = [];

export function mergedIntervalMs(intervals: Array<[number, number]>): number {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -1;
  let open = -1;
  for (const [start, end] of sorted) {
    if (cursor < 0 || start > cursor) {
      if (cursor >= 0) total += cursor - open;
      open = start;
      cursor = end;
    } else if (end > cursor) {
      cursor = end;
    }
  }
  if (cursor >= 0) total += cursor - open;
  return total;
}

/** One second is one reservation. Milliseconds and a truncated reload match. */
function spendIdentity(row: SpendRow): string {
  return `${row.key}|${Math.floor(row.start / 1000)}`;
}

function rememberSpend(flight: Flight): void {
  const row: SpendRow = {
    key: flight.key,
    jobId: flight.jobId,
    usd: flight.estCostUsd,
    start: flight.startedAt,
    end: flight.startedAt + (flight.estMs > 0 ? flight.estMs : 0),
  };
  if (spend.some((existing) => spendIdentity(existing) === spendIdentity(row))) return;
  spend.push(row);
}

function closeSpend(flight: Flight): void {
  const row = spend.find(
    (item) => item.key === flight.key && Math.abs(item.start - flight.startedAt) < 1_000
  );
  if (!row) return;
  row.end = flight.endedAt ?? Date.now();
}

/**
 * Replace the dollar ledger with rows loaded from `remote_calls`.
 * A flight key in that snapshot replaces the memory row, so a reload
 * cannot append a second copy of the same reservation. A memory row
 * whose start is newer than the snapshot is kept: it has not been written.
 */
export function replacePersistedSpend(rows: SpendRow[]): void {
  const incomingIds = new Set(rows.map(spendIdentity));
  const newest = new Map<string, number>();
  for (const row of rows) {
    newest.set(row.key, Math.max(newest.get(row.key) ?? 0, row.start));
  }
  const memory = spend.filter((row) => {
    if (incomingIds.has(spendIdentity(row))) return false;
    const persisted = newest.get(row.key);
    if (persisted == null) return true;
    return row.start > persisted + 1_000;
  });
  spend = [...rows, ...memory];
}

export function spendRows(): readonly SpendRow[] {
  return spend;
}

export function setRemoteEventSink(fn: ((event: RemoteEvent) => void) | null): void {
  eventSink = fn;
}

/** Persist a call id or tag onto the open row without adding a spend row. */
export function setRemoteFlightStamp(fn: ((flight: Flight) => void) | null): void {
  stampSink = fn;
}

function nextId(): string {
  seq += 1;
  return `rc_${seq.toString(36)}`;
}

export function resetRemoteLayerForTests(): void {
  flights.clear();
  events.length = 0;
  halted.clear();
  drainRequests.clear();
  spend = [];
  seq = 0;
  eventSink = null;
  stampSink = null;
}

export function noteDrainRequested(jobId: string | undefined): void {
  if (jobId) drainRequests.add(jobId);
}

export function takeDrainRequests(): string[] {
  const ids = [...drainRequests];
  drainRequests.clear();
  return ids;
}

export function remoteEvents(): readonly RemoteEvent[] {
  return events;
}

export function remoteFlights(): Flight[] {
  return [...flights.values()];
}

export function flightKey(input: {
  provider: RemoteProvider;
  jobId?: string;
  sections?: string[];
}): string {
  const sections = [...(input.sections ?? [])].map(String).sort().join(",");
  return `${input.provider}|${input.jobId ?? "-"}|${sections || "-"}`;
}

function record(partial: Omit<RemoteEvent, "id" | "startedAt"> & { startedAt?: number }): RemoteEvent {
  const event: RemoteEvent = {
    id: nextId(),
    startedAt: partial.startedAt ?? Date.now(),
    flightKey: partial.flightKey,
    idempotencyKey: partial.idempotencyKey,
    provider: partial.provider,
    path: partial.path,
    jobId: partial.jobId,
    section: partial.section,
    callId: partial.callId,
    callTag: partial.callTag,
    outcome: partial.outcome,
    endedAt: partial.endedAt,
    estCostUsd: partial.estCostUsd,
    error: partial.error,
  };
  events.push(event);
  try {
    eventSink?.(event);
  } catch {
    /* a log write never refuses the call */
  }
  return event;
}

export function hydrateRemoteFlight(flight: Flight): void {
  if (flight.status === "running" || flight.status === "still_live") {
    flights.set(flight.key, flight);
  }
}

export function haltBook(jobId: string, reason: string): void {
  if (!jobId) return;
  halted.set(jobId, reason);
  for (const flight of flights.values()) {
    if (flight.jobId !== jobId) continue;
    if (flight.status !== "running" && flight.status !== "still_live") continue;
    // `bindFlightAbort` is what puts this handle here. Stop aborts the
    // fetch that is still waiting on headers, then the provider records
    // still_live with the function-call id it already stored.
    try {
      flight.abort?.();
    } catch {
      /* the provider's own catch records the outcome */
    }
    // still_live stays until the stored function-call id is terminal.
    // Marking it cancelled here let the next tick POST while Modal was
    // still compiling. A running call records cancelled from its own catch.
  }
}

export function isBookHalted(jobId: string | undefined | null): boolean {
  if (!jobId) return false;
  return halted.has(jobId);
}

export function haltReason(jobId: string): string | undefined {
  return halted.get(jobId);
}

function sectionsOf(flight: Flight): string[] {
  return flight.sections;
}

function overlaps(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const set = new Set(a);
  return b.some((section) => set.has(section));
}

function sameSections(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export type AdmitResult =
  | { kind: "start"; flight: Flight; finish: (outcome: FlightStatus, error?: string) => void }
  | { kind: "join"; promise: Promise<unknown> }
  | { kind: "blocked"; reason: "cancelled" | "in_flight" | "budget"; flight?: Flight };

function budgetsEnabled(force: boolean | undefined): boolean {
  if (force === true) return true;
  if (force === false) return false;
  if (process.env.VITEST && process.env.REMOTE_ENFORCE_BUDGETS !== "1") return false;
  return process.env.REMOTE_ENFORCE_BUDGETS !== "0";
}

export function defaultBudgetCaps(env: NodeJS.ProcessEnv = process.env): BudgetCaps {
  const num = (name: string, fallback: number) => {
    const raw = Number(env[name] ?? "");
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    bookUsd: num("REMOTE_BOOK_BUDGET_USD", 20),
    dailyUsd: num("REMOTE_DAILY_BUDGET_USD", 80),
    bookMs: num("REMOTE_BOOK_BUDGET_MS", 6 * 60 * 60_000),
    dailyMs: num("REMOTE_DAILY_BUDGET_MS", 12 * 60 * 60_000),
  };
}

function intervalsOf(rows: SpendRow[], now: number): Array<[number, number]> {
  return rows.map((row) => [row.start, row.end > row.start ? row.end : now]);
}

/** Dollars and one wall clock for this book. Parallel lanes overlap. */
export function bookSpend(jobId: string, now = Date.now()): { usd: number; ms: number } {
  const rows = spend.filter((row) => row.jobId === jobId);
  return {
    usd: rows.reduce((sum, row) => sum + row.usd, 0),
    ms: mergedIntervalMs(intervalsOf(rows, now)),
  };
}

export function dailySpend(now = Date.now()): { usd: number; ms: number } {
  const cutoff = now - 24 * 60 * 60_000;
  const rows = spend.filter((row) => row.end >= cutoff || row.start >= cutoff);
  return {
    usd: rows.reduce((sum, row) => sum + row.usd, 0),
    ms: mergedIntervalMs(intervalsOf(rows, now)),
  };
}

/**
 * Admit one remote call. A running identical call is joined. Any overlap
 * with a call that is still live (including after the local wait aborted)
 * is refused. A halted book never starts a new call.
 */
export function admitRemoteCall(
  input: AdmitInput & { enforceBudget?: boolean; caps?: Partial<BudgetCaps> }
): AdmitResult {
  const now = input.now ?? Date.now();
  const sections = (input.sections ?? []).map(String);
  const key = flightKey({ provider: input.provider, jobId: input.jobId, sections });
  const idempotencyKey = input.idempotencyKey?.trim() || key;

  if (input.jobId && isBookHalted(input.jobId)) {
    record({
      flightKey: key,
      idempotencyKey,
      provider: input.provider,
      path: input.path,
      jobId: input.jobId,
      section: sections.join(","),
      outcome: "refused",
      startedAt: now,
      endedAt: now,
      error: haltReason(input.jobId) || "cancelled",
    });
    return { kind: "blocked", reason: "cancelled" };
  }

  for (const flight of flights.values()) {
    if (flight.provider !== input.provider) continue;
    if ((flight.jobId ?? "") !== (input.jobId ?? "")) continue;
    if (flight.status !== "running" && flight.status !== "still_live") continue;
    if (!overlaps(sectionsOf(flight), sections)) continue;
    if (flight.status === "running" && flight.promise && sameSections(sectionsOf(flight), sections)) {
      record({
        flightKey: flight.key,
        idempotencyKey: flight.idempotencyKey,
        provider: input.provider,
        path: input.path,
        jobId: input.jobId,
        section: sections.join(","),
        callId: flight.callId,
        outcome: "joined",
        startedAt: now,
      });
      return { kind: "join", promise: flight.promise };
    }
    record({
      flightKey: key,
      idempotencyKey,
      provider: input.provider,
      path: input.path,
      jobId: input.jobId,
      section: sections.join(","),
      callId: flight.callId,
      outcome: "refused",
      startedAt: now,
      endedAt: now,
      error: "in_flight",
    });
    return { kind: "blocked", reason: "in_flight", flight };
  }

  const estCostUsd = Math.max(0, input.estCostUsd ?? 0);
  const estMs = Math.max(0, input.estMs ?? 0);
  if (budgetsEnabled(input.enforceBudget)) {
    const caps = { ...defaultBudgetCaps(), ...input.caps };
    const book = input.jobId ? bookSpend(input.jobId, now) : { usd: 0, ms: 0 };
    const day = dailySpend(now);
    const bookRows = input.jobId ? spend.filter((row) => row.jobId === input.jobId) : [];
    const bookWall = input.jobId
      ? mergedIntervalMs([...intervalsOf(bookRows, now), [now, now + estMs]])
      : 0;
    const dayWall = mergedIntervalMs([
      ...intervalsOf(
        spend.filter((row) => row.start >= now - 24 * 60 * 60_000 || row.end >= now - 24 * 60 * 60_000),
        now
      ),
      [now, now + estMs],
    ]);
    const over =
      (input.jobId && (book.usd + estCostUsd > caps.bookUsd || bookWall > caps.bookMs)) ||
      day.usd + estCostUsd > caps.dailyUsd ||
      dayWall > caps.dailyMs;
    if (over) {
      record({
        flightKey: key,
        idempotencyKey,
        provider: input.provider,
        path: input.path,
        jobId: input.jobId,
        section: sections.join(","),
        outcome: "refused",
        startedAt: now,
        endedAt: now,
        estCostUsd,
        error: "budget",
      });
      return { kind: "blocked", reason: "budget" };
    }
  }

  const flight: Flight = {
    key,
    idempotencyKey,
    provider: input.provider,
    path: input.path,
    jobId: input.jobId,
    sections,
    status: "running",
    callId: input.callId,
    startedAt: now,
    estCostUsd,
    estMs,
  };
  flights.set(key, flight);
  record({
    flightKey: key,
    idempotencyKey,
    provider: input.provider,
    path: input.path,
    jobId: input.jobId,
    section: sections.join(","),
    callId: input.callId,
    outcome: "started",
    startedAt: now,
    estCostUsd,
  });
  rememberSpend(flight);

  let settled = false;
  const finish = (outcome: FlightStatus, error?: string) => {
    if (settled) return;
    settled = true;
    flight.status = outcome;
    flight.endedAt = Date.now();
    closeSpend(flight);
    if (outcome !== "still_live") flight.promise = undefined;
    const recorded: RemoteOutcome =
      outcome === "still_live" ? "still_live" : outcome === "running" ? "started" : outcome;
    record({
      flightKey: flight.key,
      idempotencyKey: flight.idempotencyKey,
      provider: flight.provider,
      path: flight.path,
      jobId: flight.jobId,
      section: flight.sections.join(","),
      callId: flight.callId,
      callTag: flight.tag,
      outcome: recorded,
      startedAt: flight.startedAt,
      endedAt: flight.endedAt,
      estCostUsd: flight.estCostUsd,
      error,
    });
  };
  return { kind: "start", flight, finish };
}

export type RunRemoteInput<T> = AdmitInput & {
  enforceBudget?: boolean;
  caps?: Partial<BudgetCaps>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * HTTP providers retry after an abort. A Modal spawn that may still be
   * running stays `still_live` until its function-call id is terminal.
   */
  abortSettlesAs?: "still_live" | "failure";
  execute: (ctx: { signal: AbortSignal; setCallId: (id: string) => void }) => Promise<T>;
  classifyError?: (err: unknown) => FlightStatus;
};

function timeoutOutcome(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Run one admitted call. Timeout and abort leave the flight still_live so
 * the next tick cannot start a second provider call for the same section.
 */
export async function runRemoteCall<T>(input: RunRemoteInput<T>): Promise<T> {
  const admitted = admitRemoteCall(input);
  if (admitted.kind === "join") return admitted.promise as Promise<T>;
  if (admitted.kind === "blocked") {
    const code = admitted.reason === "budget" ? "budget" : admitted.reason === "cancelled" ? "cancelled" : "in_flight";
    throw new RemoteCallRefused(
      admitted.reason === "cancelled"
        ? "This book was stopped."
        : admitted.reason === "budget"
          ? "This book is over its remote-call budget."
          : "A remote call for this section is already in flight.",
      code
    );
  }
  const { flight, finish } = admitted;
  const controller = new AbortController();
  flight.abort = () => controller.abort();
  const onExternal = () => controller.abort();
  input.signal?.addEventListener("abort", onExternal, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (input.timeoutMs && input.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), input.timeoutMs);
  }
  const work = (async () => {
    try {
      return await input.execute({
        signal: controller.signal,
        setCallId: (id: string) => {
          flight.callId = id;
        },
      });
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onExternal);
    }
  })();
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true }
    );
  });
  const raced = Promise.race([work, aborted]);
  flight.promise = raced;
  try {
    const value = await raced;
    finish("success");
    return value;
  } catch (err) {
    const classified = input.classifyError?.(err);
    const aborted = timeoutOutcome(err);
    const abortAs = input.abortSettlesAs ?? "still_live";
    const outcome: FlightStatus =
      classified ??
      (isBookHalted(input.jobId)
        ? "cancelled"
        : aborted
          ? abortAs === "failure"
            ? "failure"
            : "still_live"
          : "failure");
    finish(outcome, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Attach an abort handle to a flight the provider started itself. */
export function bindFlightAbort(key: string, abort: () => void): void {
  const flight = flights.get(key);
  if (flight) flight.abort = abort;
}

export function setFlightCallId(key: string, callId: string): void {
  const flight = flights.get(key);
  const id = callId.trim();
  if (!flight || !id || flight.callId === id) return;
  flight.callId = id;
  stampSink?.(flight);
}

/**
 * Move a still_live or running flight to a terminal outcome.
 * A non-terminal observation leaves the flight still_live.
 */
export function settleFlightCall(
  callId: string,
  outcome: FlightStatus,
  now = Date.now()
): void {
  if (outcome === "running" || outcome === "still_live") return;
  for (const flight of flights.values()) {
    if (flight.callId !== callId) continue;
    if (flight.status !== "running" && flight.status !== "still_live") continue;
    flight.status = outcome;
    flight.endedAt = now;
    flight.promise = undefined;
    closeSpend(flight);
    record({
      flightKey: flight.key,
      idempotencyKey: flight.idempotencyKey,
      provider: flight.provider,
      path: flight.path,
      jobId: flight.jobId,
      section: flight.sections.join(","),
      callId,
      callTag: flight.tag,
      outcome,
      startedAt: flight.startedAt,
      endedAt: now,
    });
  }
}

/**
 * What a cancel RPC actually proved.
 *
 * `FunctionCall.cancel` can return and then raise NotFound while the input
 * is still pending and Modal keeps scheduling snapshot containers. NotFound
 * is not proof the call is gone. A non-terminal status is not proof either.
 */
export type CancelObservation = {
  threw?: string | null;
  status?: string | null;
  httpStatus?: number | null;
};

export type CancelVerdict = "terminal" | "still_live";

const CANCEL_TERMINAL = new Set([
  "success",
  "failure",
  "terminated",
  "timeout",
  "init_failure",
  "init failure",
  "cancelled",
  "canceled",
  "1",
  "2",
  "3",
  "4",
  "5",
]);

export function interpretCancelResult(obs: CancelObservation): CancelVerdict {
  const thrown = (obs.threw ?? "").toLowerCase();
  if (thrown.includes("notfound") || thrown.includes("not found")) return "still_live";
  const status = String(obs.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^inputstatus\./, "");
  if (!status) return "still_live";
  if (CANCEL_TERMINAL.has(status)) return "terminal";
  return "still_live";
}

export type DrainStep =
  | { step: "cancel_pending"; terminateContainers: true }
  | { step: "brake_autoscaler"; maxContainers: 0; minContainers: 0 }
  | { step: "confirm_zero_containers" }
  | { step: "restore_autoscaler"; maxContainers: number; minContainers: 0 };

/**
 * Order is the whole safety property. Cancel first, then brake so a
 * NotFound that is still spawning cannot place another container. Never
 * stop a container before the cancel. Restoring the autoscaler always
 * leaves min_containers at 0.
 */
export function planDrain(restoreMaxContainers: number): DrainStep[] {
  const raw = Math.floor(restoreMaxContainers);
  const max = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return [
    { step: "cancel_pending", terminateContainers: true },
    { step: "brake_autoscaler", maxContainers: 0, minContainers: 0 },
    { step: "confirm_zero_containers" },
    { step: "restore_autoscaler", maxContainers: max, minContainers: 0 },
  ];
}

export type DrainTarget = {
  app: string;
  jobId?: string;
  callIds: string[];
  /** Other books that still have a running or still_live call. */
  otherLiveBooks?: number;
};

export type DrainOps = {
  cancel: (callId: string) => Promise<CancelObservation>;
  brake: (app: string) => Promise<void>;
  runningContainers: (app: string) => Promise<number>;
  restore: (app: string, maxContainers: number) => Promise<void>;
  /** The cap in force before any brake. Falls back to the argument. */
  readMax?: () => Promise<number>;
  /** Read again immediately before braking. A snapshot from before cancel is stale. */
  countOtherLiveBooks?: () => number | Promise<number>;
  /** How long to wait for containers to hit 0 before restoring anyway. */
  containerWaitMs?: number;
  containerPollMs?: number;
  onBrake?: (savedMax: number) => Promise<void> | void;
  onRestored?: () => Promise<void> | void;
};

export type DrainReport = {
  steps: DrainStep[];
  verdicts: Array<{ callId: string; verdict: CancelVerdict }>;
  containersAfterBrake: number;
  restored: boolean;
  braked: boolean;
  savedMax: number;
  stillLive: string[];
};

/**
 * Execute a drain. The brake runs even when cancel reports terminal, so a
 * lie from NotFound cannot keep placing GPUs. min_containers stays 0.
 * This function does not stop containers and does not stop the Modal app.
 */
export async function executeDrain(
  target: DrainTarget,
  ops: DrainOps,
  restoreMaxContainers = 0
): Promise<DrainReport> {
  let saved: number | null = null;
  try {
    const read = ops.readMax
      ? await ops.readMax()
      : Math.floor(Number.isFinite(restoreMaxContainers) ? restoreMaxContainers : 0);
    saved = Number.isFinite(read) && read >= 1 ? Math.floor(read) : null;
  } catch {
    saved = null;
  }
  const steps = planDrain(saved ?? 0);
  const verdicts: DrainReport["verdicts"] = [];
  for (const callId of target.callIds) {
    let obs: CancelObservation;
    try {
      obs = await ops.cancel(callId);
    } catch (err) {
      obs = { threw: err instanceof Error ? err.message : String(err) };
    }
    const verdict = interpretCancelResult(obs);
    verdicts.push({ callId, verdict });
    const flight = [...flights.values()].find((row) => row.callId === callId);
    if (flight && (flight.status === "running" || flight.status === "still_live")) {
      if (verdict === "terminal") {
        flight.status = "cancelled";
        flight.endedAt = Date.now();
        flight.promise = undefined;
        closeSpend(flight);
        record({
          flightKey: flight.key,
          idempotencyKey: flight.idempotencyKey,
          provider: flight.provider,
          path: flight.path,
          jobId: flight.jobId,
          section: flight.sections.join(","),
          callId,
          callTag: flight.tag,
          outcome: "cancelled",
          startedAt: flight.startedAt,
          endedAt: flight.endedAt,
          error: obs.threw || obs.status || undefined,
        });
      } else {
        flight.status = "still_live";
        flight.callId = flight.callId || callId;
      }
    }
  }
  const stillLive = verdicts.filter((row) => row.verdict === "still_live").map((row) => row.callId);
  const others = ops.countOtherLiveBooks
    ? await ops.countOtherLiveBooks()
    : (target.otherLiveBooks ?? 0);
  const shouldBrake = stillLive.length > 0 && others === 0 && saved != null;
  let containersAfterBrake = 0;
  let restored = false;
  let braked = false;
  if (!shouldBrake) {
    try {
      containersAfterBrake = await ops.runningContainers(target.app);
    } catch {
      containersAfterBrake = 0;
    }
  } else {
    braked = true;
    try {
      await ops.onBrake?.(saved!);
    } catch {
      /* a missed persist is healed only if the row was written */
    }
    try {
      try {
        await ops.brake(target.app);
        const waitMs = ops.containerWaitMs ?? 0;
        const step = ops.containerPollMs ?? 0;
        const deadline = Date.now() + waitMs;
        containersAfterBrake = await ops.runningContainers(target.app);
        while (containersAfterBrake > 0 && Date.now() < deadline) {
          if (step > 0) await new Promise((resolve) => setTimeout(resolve, step));
          containersAfterBrake = await ops.runningContainers(target.app);
        }
      } catch (err) {
        console.warn(
          "[remote] drain brake failed",
          err instanceof Error ? err.message : err
        );
      }
    } finally {
      // The brake is never left on. A wait that expires, or a throw from
      // the brake itself, still puts the saved max back. The call stays
      // still_live when it was not terminal.
      try {
        await ops.restore(target.app, saved!);
        restored = true;
        await ops.onRestored?.();
      } catch (err) {
        console.warn(
          "[remote] autoscaler restore failed",
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  return {
    steps,
    verdicts,
    containersAfterBrake,
    restored,
    braked,
    savedMax: saved ?? 0,
    stillLive,
  };
}

export type OrphanInput = {
  now?: number;
  /** Jobs that are queued, processing, or waiting. Anything else is orphaned. */
  liveJobIds: ReadonlySet<string>;
  maxAgeMs?: number;
};

/** Flights that are running or still_live with no owning live job. */
export function orphanedFlights(input: OrphanInput): Flight[] {
  const now = input.now ?? Date.now();
  const maxAge = input.maxAgeMs ?? 0;
  return remoteFlights().filter((flight) => {
    if (flight.status !== "running" && flight.status !== "still_live") return false;
    if (flight.jobId && input.liveJobIds.has(flight.jobId) && !isBookHalted(flight.jobId)) {
      return false;
    }
    if (maxAge > 0 && now - flight.startedAt < maxAge && flight.jobId && !isBookHalted(flight.jobId)) {
      return false;
    }
    return true;
  });
}

export type ModalAppSpec = {
  id: string;
  appName: string;
  className: string;
  gpu: boolean;
  minContainers: 0;
  restoreBudgetMs: number;
  healthDailyBudgetMs: number;
  maxHealthGpus: number;
  cover: { containers: number; rounds: number; streak: number; scaledown: number };
};

/**
 * One registry for every Modal app we snapshot. min_containers is 0 on
 * each of them. Health checks read this list; they do not hard-code S2.
 */
export function modalAppRegistry(env: NodeJS.ProcessEnv = process.env): ModalAppSpec[] {
  const name = (key: string, fallback: string) => env[key]?.trim() || fallback;
  return [
    {
      id: "s2-clone",
      appName: name("S2C_APP_NAME", "echomancer-s2-clone"),
      className: "S2CloneWorker",
      gpu: true,
      minContainers: 0,
      restoreBudgetMs: 60_000,
      healthDailyBudgetMs: 10 * 60_000,
      maxHealthGpus: 1,
      cover: { containers: 3, rounds: 6, streak: 3, scaledown: 300 },
    },
    {
      id: "kokoro",
      appName: name("SOWELL_APP_NAME", "echomancer-sowell"),
      className: "Speaker",
      gpu: false,
      minContainers: 0,
      restoreBudgetMs: 60_000,
      healthDailyBudgetMs: 10 * 60_000,
      maxHealthGpus: 1,
      cover: { containers: 1, rounds: 2, streak: 1, scaledown: 15 },
    },
    {
      id: "modal-cpu",
      appName: name("CPU_APP_NAME", "echomancer-cpu"),
      className: "run",
      gpu: false,
      minContainers: 0,
      restoreBudgetMs: 60_000,
      healthDailyBudgetMs: 10 * 60_000,
      maxHealthGpus: 1,
      cover: { containers: 1, rounds: 1, streak: 1, scaledown: 300 },
    },
  ];
}

export type HealthProbe = {
  app: ModalAppSpec;
  /** Wall clock of one cold placement, or null when it was not attempted. */
  restoreMs: number | null;
  graphs?: string | null;
  alreadySpentMs: number;
};

export type HealthDecision =
  | { action: "ok"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "rewarm"; reason: string; maxGpus: 1; budgetMs: number };

/**
 * A cold start that restores inside the budget is healthy. Re-warm only
 * when it does not, and only inside the remaining daily GPU budget.
 * Never raises min_containers.
 */
export function planHealthCheck(probe: HealthProbe): HealthDecision {
  if (probe.app.minContainers !== 0) {
    return { action: "skip", reason: "min_containers must stay 0" };
  }
  if (probe.alreadySpentMs >= probe.app.healthDailyBudgetMs) {
    return { action: "skip", reason: "daily health budget spent" };
  }
  if (probe.restoreMs != null && probe.restoreMs <= probe.app.restoreBudgetMs) {
    const graphs = probe.graphs ?? "";
    if (probe.app.gpu && graphs && !graphs.startsWith("ok(") && !graphs.startsWith("recaptured(")) {
      return {
        action: "rewarm",
        reason: `graphs=${graphs}`,
        maxGpus: 1,
        budgetMs: probe.app.healthDailyBudgetMs - probe.alreadySpentMs,
      };
    }
    return { action: "ok", reason: `restore ${Math.round(probe.restoreMs / 1000)}s` };
  }
  if (probe.restoreMs == null) {
    return { action: "skip", reason: "no restore sample" };
  }
  return {
    action: "rewarm",
    reason: `restore ${Math.round(probe.restoreMs / 1000)}s over ${Math.round(probe.app.restoreBudgetMs / 1000)}s`,
    maxGpus: 1,
    budgetMs: probe.app.healthDailyBudgetMs - probe.alreadySpentMs,
  };
}

export type WatchdogInput = {
  app: ModalAppSpec;
  runningContainers: number;
  /** Live jobs that own a container on this app. */
  owningJobIds: readonly string[];
  dailySpendUsd: number;
  dailyCapUsd: number;
};

export type WatchdogDecision =
  | { action: "ok" }
  | { action: "brake"; reason: string; minContainers: 0; maxContainers: 0 };

/**
 * Brake when containers are up with no owning live job, or the day's
 * spend is over the cap. The brake is max_containers=0, min_containers=0.
 * It does not stop an in-flight compile by itself.
 */
export function planWatchdog(input: WatchdogInput): WatchdogDecision {
  if (input.app.minContainers !== 0) {
    return { action: "brake", reason: "min_containers drifted above 0", minContainers: 0, maxContainers: 0 };
  }
  if (input.runningContainers > 0 && input.owningJobIds.length === 0) {
    return {
      action: "brake",
      reason: `${input.runningContainers} container(s) on ${input.app.id} with no live job`,
      minContainers: 0,
      maxContainers: 0,
    };
  }
  if (input.dailySpendUsd > input.dailyCapUsd) {
    return {
      action: "brake",
      reason: `daily spend ${input.dailySpendUsd.toFixed(2)} over ${input.dailyCapUsd.toFixed(2)}`,
      minContainers: 0,
      maxContainers: 0,
    };
  }
  return { action: "ok" };
}

/** Every started flight has a later terminal or still_live event. */
export function everyStartHasAnEnd(log: readonly RemoteEvent[] = events): boolean {
  const open = new Map<string, number>();
  for (const event of log) {
    if (event.outcome === "started") {
      open.set(event.flightKey, (open.get(event.flightKey) ?? 0) + 1);
    } else if (
      event.outcome === "success" ||
      event.outcome === "failure" ||
      event.outcome === "cancelled" ||
      event.outcome === "timeout" ||
      event.outcome === "still_live"
    ) {
      open.set(event.flightKey, (open.get(event.flightKey) ?? 0) - 1);
    }
  }
  for (const count of open.values()) {
    if (count > 0) return false;
  }
  return true;
}
