import {
  executeDrain,
  haltBook,
  remoteFlights,
  settleFlightCall,
  type CancelObservation,
  type DrainOps,
  type DrainReport,
} from "@/lib/remote/layer";
import { clearActiveBrake, saveActiveBrake } from "@/lib/remote/store";
import {
  cancelS2Call,
  resolveOpenS2Keys,
  s2ControlOrigin,
  s2Fleet,
} from "@/lib/tts/providers/modal-clone-call";

let testHooks: DrainOps | null = null;

/** Tests supply cancel / brake / restore without calling Modal. */
export function setDrainHooksForTests(hooks: DrainOps | null): void {
  testHooks = hooks;
}

export function bookCallIds(jobId: string): string[] {
  const ids = new Set<string>();
  for (const flight of remoteFlights()) {
    if (flight.jobId !== jobId) continue;
    if (flight.status !== "running" && flight.status !== "still_live") continue;
    if (flight.callId) ids.add(flight.callId);
  }
  return [...ids];
}

export function otherLiveBookCount(jobId: string): number {
  const books = new Set<string>();
  for (const flight of remoteFlights()) {
    if (!flight.jobId || flight.jobId === jobId) continue;
    if (flight.status !== "running" && flight.status !== "still_live") continue;
    if (flight.provider !== "s2-clone") continue;
    books.add(flight.jobId);
  }
  return books.size;
}

async function cancelOne(callId: string): Promise<CancelObservation> {
  return cancelS2Call(callId);
}

/** The live cap from s2_control. A missing number is a failure, not 1. */
async function printLiveMax(): Promise<number> {
  const row = await s2Fleet("read");
  if (row.maxContainers == null || row.maxContainers < 1) {
    throw new Error("live max unread");
  }
  return row.maxContainers;
}

async function setMax(max: number): Promise<void> {
  if (max === 0) {
    await s2Fleet("brake");
    return;
  }
  await s2Fleet("restore", max);
}

async function runningCount(): Promise<number> {
  const row = await s2Fleet("count");
  if (row.running == null || row.running < 0) {
    throw new Error("container count unread");
  }
  return row.running;
}

function productionOps(app: string): DrainOps {
  return {
    readMax: () => printLiveMax(),
    cancel: (callId) => cancelOne(callId),
    brake: () => setMax(0),
    runningContainers: () => runningCount(),
    restore: (_name, max) => setMax(max),
    containerWaitMs: 120_000,
    containerPollMs: 5_000,
    onBrake: (max) => saveActiveBrake(app, max),
    onRestored: () => clearActiveBrake(app),
  };
}

function controlPlaneReady(): boolean {
  return Boolean(s2ControlOrigin() && process.env.MODAL_S2_TOKEN?.trim());
}

/**
 * Stop one book's stored function calls.
 *
 * The shared autoscaler is braked only when a cancel stays non-terminal
 * and, re-checked immediately before the brake, no other S2 book has a
 * live call. Brake, restore, and the container count are posts to
 * `s2_control`. The restored max is the live cap read before the brake.
 * Every brake is restored, including when the wait expires or the brake
 * throws. The worker does not run the Modal CLI.
 */
export async function drainBookCalls(jobId: string, reason: string): Promise<DrainReport | null> {
  haltBook(jobId, reason);
  await resolveOpenS2Keys(jobId).catch(() => undefined);
  const callIds = bookCallIds(jobId);
  const app = process.env.S2C_APP_NAME?.trim() || "echomancer-s2-clone";
  const httpTest = process.env.S2_DRAIN_HTTP_TEST === "1";
  if (!testHooks && ((process.env.VITEST && !httpTest) || !controlPlaneReady())) return null;
  const ops = testHooks ?? productionOps(app);
  const report = await executeDrain(
    { app, jobId, callIds },
    {
      ...ops,
      countOtherLiveBooks: ops.countOtherLiveBooks ?? (() => otherLiveBookCount(jobId)),
    }
  );
  for (const row of report.verdicts) {
    if (row.verdict === "terminal") settleFlightCall(row.callId, "cancelled");
  }
  return report;
}
