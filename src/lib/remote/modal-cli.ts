import { spawn } from "node:child_process";

/**
 * One Modal CLI at a time.
 *
 * Autoscaler reads and the container count are the only CLI left on the
 * worker. They must not overlap, and a missing `python3` fails the call
 * instead of being treated as a live cap.
 */
const GAP_MS = 1_000;
let tail: Promise<void> = Promise.resolve();
let lastFinished = 0;

function spawnOnce(args: string[]): Promise<{ code: number; out: string }> {
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

export function runModalCli(args: string[]): Promise<{ code: number; out: string }> {
  const run = tail.then(async () => {
    const wait = GAP_MS - (Date.now() - lastFinished);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await spawnOnce(args);
    } finally {
      lastFinished = Date.now();
    }
  });
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
