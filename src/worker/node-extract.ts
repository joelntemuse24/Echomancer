/**
 * Document extract on the take-home process, outside the Whole-book
 * slot table. Each upload is a child process so a multi-megabyte PDF
 * parse does not stall audio jobs on the parent event loop.
 */

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { heartbeatUploadExtract } from "@/lib/turso/uploads";

const HEARTBEAT_MS = 20_000;

const inflight = new Map<string, ChildProcess>();
const queue: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function extractInflightCount(): number {
  return inflight.size;
}

export function extractQueuedCount(): number {
  return queue.length;
}

function extractConcurrency(): number {
  const raw = Number(process.env.EXTRACT_NODE_CONCURRENCY || "1");
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(4, Math.floor(raw));
}

/** tsx does not apply itself to a forked child unless we pass the loader. */
export function extractChildExecArgv(execArgv: string[] = process.execArgv): string[] {
  const kept = execArgv.filter((arg) => !arg.startsWith("--inspect"));
  if (kept.some((arg) => arg.includes("tsx"))) return kept;
  return ["--import", "tsx", ...kept];
}

function ensureHeartbeat(): void {
  if (timer) return;
  timer = setInterval(() => {
    const ids = [...inflight.keys(), ...queue];
    if (ids.length === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    for (const id of ids) {
      void heartbeatUploadExtract(id).catch((err) => {
        console.error(`[extract] heartbeat failed for ${id}`, err);
      });
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
}

function pump(): void {
  while (inflight.size < extractConcurrency() && queue.length > 0) {
    const uploadId = queue.shift();
    if (!uploadId || inflight.has(uploadId)) continue;
    spawnExtract(uploadId);
  }
  if (inflight.size > 0 || queue.length > 0) ensureHeartbeat();
}

function spawnExtract(uploadId: string): void {
  const childPath = fileURLToPath(new URL("./extract-child.ts", import.meta.url));
  const child = fork(childPath, [uploadId], {
    execArgv: extractChildExecArgv(),
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  inflight.set(uploadId, child);
  console.info(`[extract] child started for ${uploadId} pid=${child.pid ?? "?"}`);
  void heartbeatUploadExtract(uploadId).catch(() => {});
  child.once("exit", (code) => {
    inflight.delete(uploadId);
    if (code !== 0) {
      console.error(`[extract] child exited ${code} for ${uploadId}`);
    }
    pump();
  });
}

/**
 * Start or queue an extract. A second call for the same id is a no-op
 * so a Cloudflare fallback and a retry cannot parse twice in this process.
 */
export function startNodeExtract(uploadId: string): {
  started: boolean;
  queued: boolean;
} {
  if (inflight.has(uploadId) || queue.includes(uploadId)) {
    return { started: false, queued: true };
  }
  if (inflight.size >= extractConcurrency()) {
    queue.push(uploadId);
    ensureHeartbeat();
    console.info(`[extract] queued ${uploadId} ahead=${queue.length}`);
    return { started: false, queued: true };
  }
  spawnExtract(uploadId);
  ensureHeartbeat();
  return { started: true, queued: false };
}

export function stopNodeExtracts(): void {
  if (timer) clearInterval(timer);
  timer = null;
  queue.length = 0;
  for (const child of inflight.values()) {
    child.kill("SIGTERM");
  }
  inflight.clear();
}
