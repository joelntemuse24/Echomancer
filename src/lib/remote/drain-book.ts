import { spawn } from "node:child_process";
import {
  executeDrain,
  haltBook,
  remoteFlights,
  settleFlightCall,
  type DrainOps,
  type DrainReport,
} from "@/lib/remote/layer";

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
    books.add(flight.jobId);
  }
  return books.size;
}

function liveCap(): number {
  const raw = Number(process.env.MODAL_S2_MAX_GPUS || "20");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 20;
}

/**
 * Stop one book's stored function calls.
 *
 * The shared autoscaler is braked only when a cancel stays non-terminal
 * and no other book still has a live call. The restored max is the one
 * read before the brake.
 */
export async function drainBookCalls(jobId: string, reason: string): Promise<DrainReport | null> {
  haltBook(jobId, reason);
  const callIds = bookCallIds(jobId);
  const otherLiveBooks = otherLiveBookCount(jobId);
  const app = process.env.S2C_APP_NAME?.trim() || "echomancer-s2-clone";
  if (testHooks) {
    return executeDrain(
      { app, jobId, callIds, otherLiveBooks },
      testHooks,
      liveCap()
    );
  }
  if (process.env.VITEST || !process.env.MODAL_TOKEN_ID) return null;
  const args = [
    "scripts/s2/drain-stuck-calls.py",
    "--apply",
    "--job-id",
    jobId,
    "--app",
    app,
    "--restore-max",
    String(liveCap()),
    "--other-live-books",
    String(otherLiveBooks),
  ];
  for (const id of callIds) args.push("--call-id", id);
  const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    out += String(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    out += String(chunk);
  });
  const code = await new Promise<number>((resolve) => {
    child.on("close", (status) => resolve(status ?? 1));
  });
  for (const line of out.split("\n")) {
    const match = /^cancel\s+(\S+):\s+(terminal|still_live)/.exec(line.trim());
    if (match?.[2] === "terminal") settleFlightCall(match[1]!, "cancelled");
  }
  console.log(`[remote] drain ${jobId} exit=${code}`);
  return null;
}
