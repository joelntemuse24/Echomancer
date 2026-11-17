/**
 * One short S2 prewarm. A second click inside the hold joins the first
 * flight and does not start another container. This does not run `::cover`
 * (that RPC is allowed to compile for up to 20 minutes). The child is the
 * restore-only `prewarm` entrypoint, which cancels its own RPC on timeout.
 * The flight stays open until that process exits. min_containers stays 0.
 * A failed spawn finishes the flight as failure, so the next pick can start.
 * Vitest never spawns the process unless a test replaces the spawner.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { admitRemoteCall } from "@/lib/remote/layer";

type PrewarmChild = Pick<ChildProcess, "kill" | "on">;

let spawnImpl: ((command: string, args: string[]) => PrewarmChild) | null = null;

export function setPrewarmSpawnForTests(
  fn: ((command: string, args: string[]) => PrewarmChild) | null
): void {
  spawnImpl = fn;
}

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: "ignore" });
}

export async function prewarmS2Clone(): Promise<"ready" | "unconfigured"> {
  const admitted = admitRemoteCall({
    provider: "prewarm",
    path: "warm",
    sections: ["s2"],
    estMs: 90_000,
    estCostUsd: 0.1,
  });
  if (admitted.kind === "join") return "ready";
  if (admitted.kind === "blocked") return "unconfigured";
  const configured = Boolean(
    process.env.MODAL_TOKEN_ID?.trim() || process.env.MODAL_S2_WARM_CMD?.trim()
  );
  if ((!configured && !spawnImpl) || (process.env.VITEST && !spawnImpl)) {
    admitted.finish("failure", configured ? "vitest" : "unconfigured");
    return "unconfigured";
  }
  const child = (spawnImpl ?? defaultSpawn)("python3", [
    "-m",
    "modal",
    "run",
    "--quiet",
    "modal/s2_clone_warm.py::prewarm",
  ]);
  let settled = false;
  const finish = (ok: boolean, error?: string) => {
    if (settled) return;
    settled = true;
    if (ok) admitted.finish("success");
    else admitted.finish("failure", error);
  };
  const termMs = Number(process.env.PREWARM_TIMEOUT_MS || 100_000);
  const killMs = Number(process.env.PREWARM_KILL_MS || 5_000);
  const code = await new Promise<number>((resolve) => {
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, killMs);
    }, termMs);
    const done = (status: number) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(status);
    };
    child.on("error", (err: Error) => {
      finish(false, err.message);
      done(1);
    });
    child.on("close", (status: number | null) => {
      done(status ?? 1);
    });
  });
  if (!settled) finish(code === 0, code === 0 ? undefined : `exit ${code}`);
  return code === 0 && settled ? "ready" : "unconfigured";
}
