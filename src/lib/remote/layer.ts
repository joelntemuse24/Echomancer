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

import { randomBytes } from "node:crypto";
import { RemoteCallRefused, type RemoteEvent, type RemoteOutcome, type RemotePath, type RemoteProvider } from "@/lib/remote/types";

export type { RemoteEvent, RemoteOutcome, RemotePath, RemoteProvider } from "@/lib/remote/types";
export { RemoteCallRefused } from "@/lib/remote/types";

const TERMINAL = new Set<RemoteOutcome>([
  "success",
  "failure",
  "cancelled",
  "timeout",
  "abandoned",
]);

/** Trailing window the daily GPU budget is measured against. */
export const REMOTE_DAY_MS = 24 * 60 * 60_000;

export function isTerminalOutcome(outcome: RemoteOutcome): boolean {
  return TERMINAL.has(outcome);
}

export type FlightStatus =
  | "running"
  | "still_live"
  | "submit_unconfirmed"
  | "success"
  | "failure"
  | "cancelled"
  | "timeout";

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
  /** Last time reconcile read this id. Unset sorts first, so the window rotates. */
  polledAt?: number;
  /** First time a poll of this id came back NotFound. Age is measured from here. */
  notFoundSince?: number;
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

/**
 * Dollar reservations from `started` rows. Wall time is the merged span,
 * and only the part that sits inside the trailing day counts as today.
 * Fish and previews set `gpu` false: they are not Modal GPU time.
 */
export type SpendRow = {
  key: string;
  jobId?: string;
  provider?: RemoteProvider;
  path?: RemotePath;
  /** False for Fish. Omitted rows still count. A GPU provider counts even when this is false. */
  gpu?: boolean;
  usd: number;
  start: number;
  end: number;
  /** Set when a terminal end was written. Later passes leave it alone. */
  closed?: boolean;
};

/**
 * Fish is the hosted HTTP API, including its preview bake. It is not Modal
 * GPU time. Every other provider counts, including a clone or Kokoro call
 * that was labelled `preview`: that label must not move GPU work off the
 * book and daily caps.
 */
const GPU_BUDGET_PROVIDERS = new Set<RemoteProvider>([
  "s2-clone",
  "kokoro",
  "modal-cpu",
  "prewarm",
]);

export function countsTowardGpuBudget(provider: RemoteProvider, path: RemotePath): boolean {
  if (GPU_BUDGET_PROVIDERS.has(provider)) return true;
  if (provider === "fish") return false;
  if (path === "preview" || provider === "preview") return false;
  return true;
}

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
    provider: flight.provider,
    path: flight.path,
    gpu: countsTowardGpuBudget(flight.provider, flight.path),
    usd: flight.estCostUsd,
    start: flight.startedAt,
    end: flight.startedAt + (flight.estMs > 0 ? flight.estMs : 0),
    // Open until a terminal end is written. Elapsed time and the remaining
    // reservation both count; a still-live observation must not freeze either.
    closed: false,
  };
  if (spend.some((existing) => spendIdentity(existing) === spendIdentity(row))) return;
  spend.push(row);
}

function releaseFlightReservation(flight: Flight): void {
  flight.estCostUsd = 0;
  flight.estMs = 0;
  const row = spend.find(
    (item) => item.key === flight.key && Math.abs(item.start - flight.startedAt) < 1_000
  );
  if (row) row.usd = 0;
  void import("@/lib/remote/store")
    .then((store) => store.releasePersistedReservation(flight.key, flight.startedAt))
    .catch(() => undefined);
}

function closeSpend(flight: Flight): void {
  const row = spend.find(
    (item) => item.key === flight.key && Math.abs(item.start - flight.startedAt) < 1_000
  );
  if (!row || flight.endedAt == null || row.closed) return;
  // A still-live or unconfirmed observation is not the end of the call.
  // Replacing the reservation with that timestamp drops the rest of the
  // estimate, and the next admission then fits under the cap.
  if (
    flight.status !== "success" &&
    flight.status !== "failure" &&
    flight.status !== "cancelled" &&
    flight.status !== "timeout"
  ) {
    return;
  }
  row.end = flight.endedAt;
  row.closed = true;
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
  // Unique across process restarts. A recycled `rc_1` used to hit
  // ON CONFLICT and move an abandoned row's ended_at forward.
  return `rc_${Date.now().toString(36)}_${seq.toString(36)}_${randomBytes(4).toString("hex")}`;
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
  if (
    flight.status === "running" ||
    flight.status === "still_live" ||
    flight.status === "submit_unconfirmed"
  ) {
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

/** One call cannot be charged longer than a book's own time budget. */
export function remoteCallCapMs(env: NodeJS.ProcessEnv = process.env): number {
  return defaultBudgetCaps(env).bookMs;
}

function rowCountsAsGpu(row: SpendRow): boolean {
  // Provider wins over a stored `gpu: false`. A clone row must not leave
  // the ledger because an older writer marked the preview flag.
  if (row.provider) return countsTowardGpuBudget(row.provider, row.path ?? "book");
  return row.gpu !== false;
}

/**
 * The span this row is allowed to charge.
 * An open row runs until now and keeps a future reservation. A closed row
 * stays on the end that was stored. A span longer than the per-call cap
 * keeps its most recent cap of time, so a tail that still sits in the
 * trailing day is charged and a stretched abandoned row cannot fill it.
 */
export function chargedInterval(row: SpendRow, now: number): [number, number] | null {
  if (!rowCountsAsGpu(row)) return null;
  if (!Number.isFinite(row.start)) return null;
  const storedEnd = row.end > row.start ? row.end : row.start;
  const end = row.closed === false ? Math.max(now, storedEnd) : storedEnd;
  let start = row.start;
  const cap = remoteCallCapMs();
  if (end - start > cap) start = end - cap;
  if (!(end > start)) return null;
  return [start, end];
}

function intervalsOf(rows: readonly SpendRow[], now: number): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  for (const row of rows) {
    const interval = chargedInterval(row, now);
    if (interval) intervals.push(interval);
  }
  return intervals;
}

/**
 * Elapsed time merges: Kokoro lanes share one wall clock. Time still in
 * the future is a reservation and is summed, because those calls run one
 * after another on the single GPU and overlapping them from `now` would
 * let several book estimates hide inside one interval.
 */
function accountedMs(intervals: Array<[number, number]>, now: number): number {
  const elapsed: Array<[number, number]> = [];
  let reserved = 0;
  for (const [start, end] of intervals) {
    if (!(end > start)) continue;
    const elapsedEnd = Math.min(end, now);
    if (elapsedEnd > start) elapsed.push([start, elapsedEnd]);
    if (end > now) {
      const reserveStart = Math.max(start, now);
      if (end > reserveStart) reserved += end - reserveStart;
    }
  }
  return mergedIntervalMs(elapsed) + reserved;
}

/** Dollars and one wall clock for this book. Parallel lanes overlap. Fish does not count. */
export function bookSpend(jobId: string, now = Date.now()): { usd: number; ms: number } {
  const rows = spend.filter((row) => row.jobId === jobId && rowCountsAsGpu(row));
  return {
    usd: rows.reduce((sum, row) => sum + row.usd, 0),
    ms: accountedMs(intervalsOf(rows, now), now),
  };
}

/**
 * GPU time and dollars whose span overlaps the trailing 24h.
 * Each call contributes only that overlap, and never more than its own
 * capped wall time. A reservation that has not been spent yet still counts,
 * so a second book cannot be admitted against an estimate that was clipped
 * down to the few seconds since the first call started.
 */
export function dailySpend(now = Date.now()): { usd: number; ms: number } {
  return dailySpendOf(spend, now);
}

export function dailySpendOf(rows: readonly SpendRow[], now = Date.now()): { usd: number; ms: number } {
  const windowStart = now - REMOTE_DAY_MS;
  let usd = 0;
  const intervals: Array<[number, number]> = [];
  for (const row of rows) {
    if (!rowCountsAsGpu(row)) continue;
    const interval = chargedInterval(row, now);
    let overlaps = false;
    if (interval) {
      const start = Math.max(interval[0], windowStart);
      const end = interval[1];
      if (end > start) {
        overlaps = true;
        intervals.push([start, end]);
      }
    }
    const prospective = row.start >= now - 1_000 && row.start <= now + 1_000;
    if (overlaps || prospective) usd += row.usd;
  }
  return { usd, ms: accountedMs(intervals, now) };
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
  if (
    budgetsEnabled(input.enforceBudget) &&
    countsTowardGpuBudget(input.provider, input.path)
  ) {
    const caps = { ...defaultBudgetCaps(), ...input.caps };
    // One call longer than a book's own cap would otherwise be charged as
    // that cap and admitted, then run past it.
    if (estMs > caps.bookMs || estMs > caps.dailyMs) {
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
    const pending: SpendRow = {
      key: "pending",
      jobId: input.jobId,
      provider: input.provider,
      path: input.path,
      gpu: true,
      usd: estCostUsd,
      start: now,
      end: now + estMs,
    };
    const bookRows = input.jobId
      ? spend.filter((row) => row.jobId === input.jobId && rowCountsAsGpu(row))
      : [];
    const dayRows = spend.filter((row) => rowCountsAsGpu(row));
    const bookUsd = bookRows.reduce((sum, row) => sum + row.usd, 0);
    const bookWall = input.jobId
      ? accountedMs(intervalsOf([...bookRows, pending], now), now)
      : 0;
    const day = dailySpendOf([...dayRows, pending], now);
    const over =
      (input.jobId && (bookUsd + estCostUsd > caps.bookUsd || bookWall > caps.bookMs)) ||
      day.usd > caps.dailyUsd ||
      day.ms > caps.dailyMs;
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

export type RemoteSettlement = {
  outcome: FlightStatus;
  /** The call never reached a billable container. Drop its reservation. */
  release?: boolean;
  error?: Error;
};

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
  /**
   * A returned value can still be a platform failure. `success` is only
   * the default when this returns nothing.
   */
  settle?: (value: T) => Promise<RemoteSettlement | null | undefined> | RemoteSettlement | null | undefined;
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
    const settled = (await input.settle?.(value)) ?? null;
    if (settled?.release) releaseFlightReservation(flight);
    if (settled?.error) {
      finish(settled.outcome, settled.error.message);
      throw settled.error;
    }
    finish(settled?.outcome ?? "success");
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
 * A Dict lookup found the call that an accept never returned.
 * The flight becomes still_live so poll, drain, and cover can see it.
 * A newer flight for the same sections is left alone; the id is stored
 * beside it so a spawned call is not dropped.
 */
export function adoptFlightCall(idempotencyKey: string, callId: string): boolean {
  const key = idempotencyKey.trim();
  const id = callId.trim();
  if (!key || !id) return false;
  let adopted = false;
  for (const flight of flights.values()) {
    if (flight.idempotencyKey !== key) continue;
    if (flight.callId && flight.callId !== id) continue;
    if (
      flight.status !== "submit_unconfirmed" &&
      flight.status !== "running" &&
      flight.status !== "still_live" &&
      flight.status !== "failure"
    ) {
      continue;
    }
    flight.callId = id;
    if (flight.status === "submit_unconfirmed" || flight.status === "failure") {
      flight.status = "still_live";
    }
    stampSink?.(flight);
    adopted = true;
  }
  return adopted;
}

/** Remember an id whose flight row was already replaced by a later attempt. */
export function rememberTrackedCall(input: {
  idempotencyKey: string;
  callId: string;
  jobId?: string;
  sections?: string[];
}): void {
  const id = input.callId.trim();
  if (!id) return;
  for (const flight of flights.values()) {
    if (flight.callId === id) return;
  }
  const sections = input.sections ?? [];
  const key = `s2-clone|${input.jobId ?? "-"}|${sections.join(",")}|tracked|${id}`;
  const flight: Flight = {
    key,
    idempotencyKey: input.idempotencyKey,
    provider: "s2-clone",
    path: "book",
    jobId: input.jobId,
    sections,
    status: "still_live",
    callId: id,
    startedAt: Date.now(),
    estCostUsd: 0,
    estMs: 0,
  };
  flights.set(key, flight);
  stampSink?.(flight);
}

/** How long a stored id has been NotFound. The first observation starts the clock. */
export function noteFlightNotFound(callId: string, now = Date.now()): number {
  const id = callId.trim();
  if (!id) return 0;
  let age = 0;
  for (const flight of flights.values()) {
    if (flight.callId !== id) continue;
    if (
      flight.status !== "running" &&
      flight.status !== "still_live" &&
      flight.status !== "submit_unconfirmed"
    ) {
      continue;
    }
    if (!flight.notFoundSince) flight.notFoundSince = now;
    age = Math.max(age, now - flight.notFoundSince);
  }
  return age;
}

export function clearFlightNotFound(callId: string): void {
  const id = callId.trim();
  if (!id) return;
  for (const flight of flights.values()) {
    if (flight.callId === id) flight.notFoundSince = undefined;
  }
}

/** Tests age a NotFound observation without waiting out the render budget. */
export function rewindFlightNotFoundForTests(callId: string, ms: number): void {
  const id = callId.trim();
  for (const flight of flights.values()) {
    if (flight.callId === id && flight.notFoundSince) flight.notFoundSince -= ms;
  }
}

/** Remember that this id was read, so the next pass starts at an older one. */
export function noteFlightPolled(callId: string, at = Date.now()): void {
  const id = callId.trim();
  if (!id) return;
  for (const flight of flights.values()) {
    if (flight.callId === id) flight.polledAt = at;
  }
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
  if (outcome === "running" || outcome === "still_live" || outcome === "submit_unconfirmed") return;
  for (const flight of flights.values()) {
    if (flight.callId !== callId) continue;
    if (
      flight.status !== "running" &&
      flight.status !== "still_live" &&
      flight.status !== "submit_unconfirmed"
    ) {
      continue;
    }
    // The stored end is this observation. The charge is capped later, so a
    // real tail inside the trailing day is not replaced by the first six
    // hours of the call. A later pass does not write this flight again.
    const end = Math.max(flight.startedAt, now);
    flight.status = outcome;
    flight.endedAt = end;
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
      endedAt: end,
    });
  }
}

/**
 * End used the first time a call is reaped.
 * A recent heartbeat wins when it is inside the cap. Otherwise the end is
 * `now` for a call that just finished, or the cap for one that has already
 * been open longer than a book is allowed to run. It is not `now` merely
 * because a later cleanup pass observed the row.
 */
export function terminalEnd(flight: Pick<Flight, "startedAt" | "polledAt" | "endedAt">, now: number): number {
  // Already closed once. A later cleanup must not slide the end forward.
  if (flight.endedAt != null && flight.endedAt > flight.startedAt) {
    return flight.endedAt;
  }
  const capEnd = flight.startedAt + remoteCallCapMs();
  // A heartbeat inside the cap is the last time the call was seen alive.
  // Past the cap the observation is `now`: the charge keeps only the most
  // recent cap of that span, which is the part still inside the day.
  if (
    flight.polledAt != null &&
    flight.polledAt > flight.startedAt &&
    flight.polledAt <= capEnd
  ) {
    return Math.min(flight.polledAt, now);
  }
  return Math.max(flight.startedAt, now);
}

/**
 * Close one stale open flight. A second call leaves the end where it was.
 * Returns true only when this pass wrote the end.
 */
export function abandonFlight(flight: Flight, now = Date.now()): boolean {
  if (
    flight.status !== "running" &&
    flight.status !== "still_live" &&
    flight.status !== "submit_unconfirmed"
  ) {
    return false;
  }
  const end = terminalEnd(flight, now);
  flight.status = "cancelled";
  flight.endedAt = end;
  flight.promise = undefined;
  closeSpend(flight);
  record({
    flightKey: flight.key,
    idempotencyKey: flight.idempotencyKey,
    provider: flight.provider,
    path: flight.path,
    jobId: flight.jobId,
    section: flight.sections.join(","),
    callId: flight.callId,
    callTag: flight.tag,
    outcome: "abandoned",
    startedAt: flight.startedAt,
    endedAt: end,
    error: "abandoned",
  });
  return true;
}

/** Open flights older than the per-call cap. Each one is closed once. */
export function reapStaleFlights(now = Date.now()): number {
  const cap = remoteCallCapMs();
  let closed = 0;
  for (const flight of flights.values()) {
    if (now - flight.startedAt < cap) continue;
    if (abandonFlight(flight, now)) closed += 1;
  }
  return closed;
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
  "expired",
  "1",
  "2",
  "3",
  "4",
  "5",
]);

export function interpretCancelResult(obs: CancelObservation): CancelVerdict {
  const status = String(obs.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^inputstatus\./, "");
  // An explicit terminal status wins. NotFound is not one of them: get()
  // can raise it while the input is still pending. A thrown NotFound with
  // no terminal status is still live.
  if (status && CANCEL_TERMINAL.has(status)) return "terminal";
  const thrown = (obs.threw ?? "").toLowerCase();
  if (thrown.includes("notfound") || thrown.includes("not found")) return "still_live";
  if (!status) return "still_live";
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
      // Matches `CPU_SCALEDOWN_SECONDS` (10). The five-minute New Book warm
      // is a worker keepalive, not this window.
      cover: { containers: 1, rounds: 1, streak: 1, scaledown: 10 },
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
      event.outcome === "abandoned" ||
      event.outcome === "still_live" ||
      event.outcome === "submit_unconfirmed"
    ) {
      open.set(event.flightKey, (open.get(event.flightKey) ?? 0) - 1);
    }
  }
  for (const count of open.values()) {
    if (count > 0) return false;
  }
  return true;
}
