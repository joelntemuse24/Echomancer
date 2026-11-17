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
  applyListedCalls,
  dailySpend,
  defaultBudgetCaps,
  haltBook,
  modalAppRegistry,
  orphanedFlights,
  planHealthCheck,
  planWatchdog,
  remoteFlights,
  setRemoteEventSink,
  takeDrainRequests,
  type ListedCall,
} from "@/lib/remote/layer";
import { hydrateOpenRemoteCalls, persistRemoteEvent } from "@/lib/remote/store";

/**
 * List function calls only when this process may talk to Modal.
 * Tests and a worker with no token get an empty list.
 */
export async function listModalFunctionCalls(): Promise<ListedCall[]> {
  if (process.env.VITEST || !process.env.MODAL_TOKEN_ID) return [];
  const { spawn } = await import("node:child_process");
  const child = spawn("python3", ["scripts/s2/drain-stuck-calls.py", "--list-json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    out += String(chunk);
  });
  const code = await new Promise<number>((resolve) => {
    child.on("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(out) as ListedCall[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function reconcileRemoteCalls(): Promise<void> {
  setRemoteEventSink((event) => {
    void persistRemoteEvent(event);
  });
  await hydrateOpenRemoteCalls();
  const listed = await listModalFunctionCalls();
  if (listed.length > 0) applyListedCalls(listed);
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
