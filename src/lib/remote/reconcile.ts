/**
 * Worker startup and the hourly pass share this.
 *
 * Open rows are loaded back into the single-flight map, so a restart
 * cannot start a second call for a section that is still compiling.
 * A flight whose book is gone is halted. The health and watchdog plans
 * are logged. They do not raise min_containers, and they do not place a GPU.
 */

import { query } from "@/lib/turso";
import {
  dailySpend,
  defaultBudgetCaps,
  haltBook,
  modalAppRegistry,
  noteDrainRequested,
  orphanedFlights,
  planHealthCheck,
  planWatchdog,
  setRemoteEventSink,
} from "@/lib/remote/layer";
import { hydrateOpenRemoteCalls, persistRemoteEvent } from "@/lib/remote/store";

export async function reconcileRemoteCalls(): Promise<void> {
  setRemoteEventSink((event) => {
    void persistRemoteEvent(event);
  });
  await hydrateOpenRemoteCalls();
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
  for (const flight of orphanedFlights({ liveJobIds })) {
    if (!flight.jobId) continue;
    haltBook(flight.jobId, "orphaned");
    noteDrainRequested(flight.jobId);
    console.warn("[remote] orphaned call", flight.provider, flight.jobId, flight.callId ?? "");
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
