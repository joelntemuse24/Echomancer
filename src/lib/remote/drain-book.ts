import { spawn } from "node:child_process";
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

function runPy(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      out += String(chunk);
    });
    child.on("error", () => resolve({ code: 1, out }));
    child.on("close", (status) => resolve({ code: status ?? 1, out }));
  });
}

function lastLine(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? "";
}

/** The live autoscaler cap. Never the env default, and never a guessed 1. */
async function printLiveMax(app: string): Promise<number> {
  const { code, out } = await runPy([
    "scripts/s2/set-live-autoscaler.py",
    "--print-max",
    "--app",
    app,
    "--profile",
    "ntemusejoel",
  ]);
  const n = Number(lastLine(out));
  if (code !== 0 || !Number.isInteger(n) || n < 1) {
    throw new Error(out.trim() || "live max unread");
  }
  return n;
}

async function cancelOne(app: string, callId: string): Promise<CancelObservation> {
  const { code, out } = await runPy([
    "scripts/s2/drain-stuck-calls.py",
    "--cancel-only",
    "--app",
    app,
    "--profile",
    "ntemusejoel",
    "--call-id",
    callId,
  ]);
  const match = /cancel\s+\S+:\s+(terminal|still_live)/.exec(out);
  if (match?.[1] === "terminal") return { status: "terminated" };
  if (match?.[1] === "still_live") return { status: "pending", threw: out.trim() };
  return { threw: out.trim() || `exit ${code}` };
}

async function setMax(app: string, max: number): Promise<void> {
  const args = [
    "scripts/s2/set-live-autoscaler.py",
    "--app",
    app,
    "--scaledown-window",
    "15",
    "--profile",
    "ntemusejoel",
  ];
  if (max === 0) args.push("--brake");
  else args.push("--max-containers", String(max));
  const { code, out } = await runPy(args);
  if (code !== 0) throw new Error(out.trim() || "autoscaler update failed");
}

async function runningCount(app: string): Promise<number> {
  const { code, out } = await runPy([
    "scripts/s2/drain-stuck-calls.py",
    "--running-count",
    "--app",
    app,
    "--profile",
    "ntemusejoel",
  ]);
  const n = Number(lastLine(out));
  if (code !== 0 || !Number.isInteger(n) || n < 0) {
    throw new Error(out.trim() || "container count unread");
  }
  return n;
}

function productionOps(app: string): DrainOps {
  return {
    readMax: () => printLiveMax(app),
    cancel: (callId) => cancelOne(app, callId),
    brake: () => setMax(app, 0),
    runningContainers: () => runningCount(app),
    restore: (_name, max) => setMax(app, max),
    containerWaitMs: 120_000,
    containerPollMs: 5_000,
    onBrake: (max) => saveActiveBrake(app, max),
    onRestored: () => clearActiveBrake(app),
  };
}

/**
 * Stop one book's stored function calls.
 *
 * The shared autoscaler is braked only when a cancel stays non-terminal
 * and, re-checked immediately before the brake, no other S2 book has a
 * live call. The restored max is the live cap read with `--print-max`
 * before the brake. Every brake is restored, including when the wait
 * expires or the brake throws.
 */
export async function drainBookCalls(jobId: string, reason: string): Promise<DrainReport | null> {
  haltBook(jobId, reason);
  const callIds = bookCallIds(jobId);
  const app = process.env.S2C_APP_NAME?.trim() || "echomancer-s2-clone";
  if (!testHooks && (process.env.VITEST || !process.env.MODAL_TOKEN_ID)) return null;
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
