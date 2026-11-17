/**
 * Worker startup and the hourly pass share this.
 *
 * Open rows are loaded back into the single-flight map, so a restart
 * cannot start a second call for a section that is still compiling.
 * A flight whose book is gone is halted. The health and watchdog plans
 * are logged. They do not raise min_containers, and they do not place a GPU.
 */

import { query } from "@/lib/turso";
import { drainBookCalls } from "@/lib/remote/drain-book";
import {
  dailySpend,
  defaultBudgetCaps,
  haltBook,
  modalAppRegistry,
  orphanedFlights,
  planHealthCheck,
  planWatchdog,
  noteFlightPolled,
  remoteFlights,
  setRemoteEventSink,
  setRemoteFlightStamp,
  settleFlightCall,
  takeDrainRequests,
} from "@/lib/remote/layer";
import { runModalCli } from "@/lib/remote/modal-cli";
import { isTerminalS2Status, pollS2Call } from "@/lib/tts/providers/modal-clone-call";
import {
  clearActiveBrake,
  hydrateOpenRemoteCalls,
  loadActiveBrakes,
  persistRemoteEvent,
  stampOpenRemoteCall,
} from "@/lib/remote/store";

let brakeHealer: ((app: string, savedMax: number) => Promise<void>) | null = null;
let liveMaxReader: ((app: string) => Promise<number | null>) | null = null;

export function setBrakeHealerForTests(
  fn: ((app: string, savedMax: number) => Promise<void>) | null
): void {
  brakeHealer = fn;
}

/** Tests report the live autoscaler cap. Null means it could not be read. */
export function setBrakeMaxReaderForTests(
  fn: ((app: string) => Promise<number | null>) | null
): void {
  liveMaxReader = fn;
}

async function restoreBrake(app: string, savedMax: number): Promise<void> {
  if (brakeHealer) {
    await brakeHealer(app, savedMax);
    return;
  }
  if (process.env.VITEST || !process.env.MODAL_TOKEN_ID) {
    throw new Error("brake restore is not configured");
  }
  const { code, out } = await runModalCli([
    "scripts/s2/set-live-autoscaler.py",
    "--app",
    app,
    "--max-containers",
    String(savedMax),
    "--scaledown-window",
    "15",
  ]);
  if (code !== 0) throw new Error(out.trim() || `brake restore exited ${code}`);
}

async function readLiveMax(app: string): Promise<number | null> {
  if (liveMaxReader) return liveMaxReader(app);
  if (process.env.VITEST || !process.env.MODAL_TOKEN_ID) return null;
  const { code, out } = await runModalCli([
    "scripts/s2/set-live-autoscaler.py",
    "--print-max",
    "--app",
    app,
  ]);
  const line = out
    .trim()
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
    .pop();
  const n = Number(line);
  if (code !== 0 || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Put back a max that a crashed drain left at 0.
 *
 * The row is one this process wrote. Restore only while the live cap is
 * still 0. Any other cap was set after the drain — leave it, and drop the
 * row so the next hour does not overwrite it.
 */
export async function healStuckBrakes(): Promise<number> {
  let rows: Array<{ app: string; savedMax: number }> = [];
  try {
    rows = await loadActiveBrakes();
  } catch {
    return 0;
  }
  let healed = 0;
  for (const row of rows) {
    if (!Number.isInteger(row.savedMax) || row.savedMax < 1) continue;
    const live = await readLiveMax(row.app);
    if (live !== 0) {
      if (live !== null) {
        await clearActiveBrake(row.app).catch(() => undefined);
      }
      continue;
    }
    try {
      await restoreBrake(row.app, row.savedMax);
      await clearActiveBrake(row.app);
      healed += 1;
    } catch (err) {
      console.warn(
        "[remote] stuck brake was not restored",
        row.app,
        err instanceof Error ? err.message : err
      );
    }
  }
  return healed;
}

const STORED_ID_POLL_LIMIT = 8;

function outcomeForTerminalStatus(status: string): "success" | "cancelled" | "failure" {
  const normalized = status.trim().toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "failure";
}

/**
 * One short read of the oldest-polled stored ids that are still open.
 *
 * Startup and the hourly pass both call this. The window moves, so an id
 * that stays pending does not keep every later id waiting another hour.
 * A transport problem, or NotFound while the input may still be pending,
 * stays `unknown` and the flight stays live. `expired` is terminal, so
 * the next tick may submit again. The cap is one pass, not a loop.
 */
export async function pollStoredS2Calls(limit = STORED_ID_POLL_LIMIT): Promise<number> {
  const open = remoteFlights()
    .filter(
      (flight) =>
        flight.provider === "s2-clone" &&
        (flight.status === "running" || flight.status === "still_live") &&
        Boolean(flight.callId)
    )
    .sort(
      (a, b) =>
        (a.polledAt ?? 0) - (b.polledAt ?? 0) || a.startedAt - b.startedAt
    );
  let settled = 0;
  for (const flight of open.slice(0, Math.max(0, limit))) {
    const callId = flight.callId;
    if (!callId) continue;
    noteFlightPolled(callId);
    let status = "unknown";
    try {
      status = (await pollS2Call(callId)).status;
    } catch {
      status = "unknown";
    }
    if (!isTerminalS2Status(status)) continue;
    settleFlightCall(callId, outcomeForTerminalStatus(status));
    settled += 1;
  }
  return settled;
}

export async function reconcileRemoteCalls(): Promise<void> {
  setRemoteEventSink((event) => {
    void persistRemoteEvent(event);
  });
  setRemoteFlightStamp((flight) => {
    void stampOpenRemoteCall(flight);
  });
  await hydrateOpenRemoteCalls();
  await pollStoredS2Calls().catch((err) => {
    console.warn(
      "[remote] stored call poll failed",
      err instanceof Error ? err.message : err
    );
  });
  await healStuckBrakes();
  for (const jobId of takeDrainRequests()) {
    await drainBookCalls(jobId, "drain").catch((err) => {
      console.warn("[remote] drain failed", jobId, err instanceof Error ? err.message : err);
    });
  }
  let live: { id: string }[] = [];
  try {
    live = await query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE deleted_at IS NULL AND status IN ('queued', 'processing', 'waiting')`
    );
  } catch {
    live = [];
  }
  const liveJobIds = new Set(live.map((row) => row.id));
  const orphanedJobs = new Set<string>();
  for (const flight of orphanedFlights({ liveJobIds })) {
    if (!flight.jobId) continue;
    orphanedJobs.add(flight.jobId);
    console.warn("[remote] orphaned call", flight.provider, flight.jobId, flight.callId ?? "");
  }
  for (const jobId of orphanedJobs) {
    await drainBookCalls(jobId, "orphaned").catch(() => undefined);
    if (
      remoteFlights().some(
        (flight) => flight.jobId === jobId && (flight.status === "running" || flight.status === "still_live")
      )
    ) {
      haltBook(jobId, "orphaned");
    }
  }
  const spend = dailySpend();
  const caps = defaultBudgetCaps();
  for (const app of modalAppRegistry()) {
    const watchdog = planWatchdog({
      app,
      runningContainers: 0,
      owningJobIds: [],
      dailySpendUsd: spend.usd,
      dailyCapUsd: caps.dailyUsd,
    });
    const health = planHealthCheck({ app, restoreMs: null, alreadySpentMs: 0 });
    console.info(
      `[remote] ${app.id} watchdog=${watchdog.action} health=${health.action} min_containers=${app.minContainers}`
    );
  }
}
