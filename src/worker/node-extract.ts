/**
 * Document extract on the take-home process, outside the Whole-book
 * slot table. A warm child parses each upload so a multi-megabyte PDF
 * does not stall audio jobs and a tiny file does not pay Node startup
 * again. Parsing stays in the child. The child's execArgv is the
 * parent's (inspector stripped, tsx loader kept), so a heap cap the
 * process was started with still applies. `EXTRACT_CHILD_MEMORY_MB`
 * sets an explicit V8 old-space cap on top of that.
 */

import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { heartbeatUploadExtract } from "@/lib/turso/uploads";

const HEARTBEAT_MS = 20_000;
/** Idle heap above this starts a fresh child so a large PDF does not stick. */
const DEFAULT_RECYCLE_HEAP_MB = 1024;

interface ExtractChildHandle {
  readonly pid?: number;
  send(message: unknown): boolean;
  on(event: string, listener: (message: unknown) => void): unknown;
  once(event: string, listener: (code: number | null) => void): unknown;
  removeAllListeners(event?: string): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface WarmSlot {
  child: ExtractChildHandle;
  ready: boolean;
  uploadId: string | null;
}

const slots: WarmSlot[] = [];
const queue: string[] = [];
let nextRequestId = 1;
let timer: ReturnType<typeof setInterval> | null = null;
let stopped = false;
let listenPrepHandler: ((uploadId: string) => void) | null = null;
let spawner: () => ExtractChildHandle = defaultSpawn;

export function extractInflightCount(): number {
  return slots.filter((slot) => slot.uploadId).length;
}

export function extractQueuedCount(): number {
  return queue.length;
}

function extractConcurrency(): number {
  const raw = Number(process.env.EXTRACT_NODE_CONCURRENCY || "1");
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(4, Math.floor(raw));
}

function recycleHeapMb(): number {
  const raw = Number(process.env.EXTRACT_CHILD_RECYCLE_MB || DEFAULT_RECYCLE_HEAP_MB);
  if (!Number.isFinite(raw) || raw < 64) return DEFAULT_RECYCLE_HEAP_MB;
  return Math.floor(raw);
}

/**
 * tsx does not apply itself to a forked child unless we pass the loader.
 * A heap cap already on the parent is kept. `EXTRACT_CHILD_MEMORY_MB`
 * adds one only when the parent did not set `--max-old-space-size`.
 */
export function extractChildExecArgv(execArgv: string[] = process.execArgv): string[] {
  const kept = execArgv.filter((arg) => !arg.startsWith("--inspect"));
  const withLoader = kept.some((arg) => arg.includes("tsx"))
    ? kept
    : ["--import", "tsx", ...kept];
  const memoryMb = Number(process.env.EXTRACT_CHILD_MEMORY_MB || "");
  if (
    Number.isFinite(memoryMb) &&
    memoryMb > 0 &&
    !withLoader.some((arg) => arg.startsWith("--max-old-space-size"))
  ) {
    return [...withLoader, `--max-old-space-size=${Math.floor(memoryMb)}`];
  }
  return withLoader;
}

function childForkOptions(): ForkOptions {
  return {
    execArgv: extractChildExecArgv(),
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  };
}

function defaultSpawn(): ChildProcess {
  const childPath = fileURLToPath(new URL("./extract-child.ts", import.meta.url));
  return fork(childPath, [], childForkOptions());
}

/** Parent starts listen-prep when the child finishes a read. */
export function setExtractListenPrepHandler(
  handler: ((uploadId: string) => void) | null
): void {
  listenPrepHandler = handler;
}

/** Test hook. Production uses a forked `extract-child.ts`. */
export function installExtractChildSpawner(
  spawn: (() => ExtractChildHandle) | null
): void {
  spawner = spawn ?? defaultSpawn;
}

export function resetNodeExtractForTests(): void {
  stopped = false;
  queue.length = 0;
  listenPrepHandler = null;
  spawner = defaultSpawn;
  if (timer) clearInterval(timer);
  timer = null;
  for (const slot of slots) {
    slot.child.removeAllListeners("exit");
    slot.child.kill("SIGTERM");
  }
  slots.length = 0;
  nextRequestId = 1;
}

function ensureHeartbeat(): void {
  if (timer || stopped) return;
  timer = setInterval(() => {
    const ids = [
      ...slots.map((slot) => slot.uploadId).filter((id): id is string => Boolean(id)),
      ...queue,
    ];
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

function dropSlot(slot: WarmSlot): void {
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
}

function ensureSlots(): void {
  if (stopped) return;
  const want = extractConcurrency();
  while (slots.length < want) spawnSlot();
}

function spawnSlot(): WarmSlot {
  const child = spawner();
  const slot: WarmSlot = { child, ready: false, uploadId: null };
  slots.push(slot);
  child.on("message", (message) => onChildMessage(slot, message));
  child.once("exit", (code) => onChildExit(slot, code));
  return slot;
}

function retire(slot: WarmSlot): void {
  dropSlot(slot);
  slot.child.removeAllListeners("exit");
  slot.child.kill("SIGTERM");
  ensureSlots();
}

function onChildMessage(slot: WarmSlot, message: unknown): void {
  if (!message || typeof message !== "object") return;
  const msg = message as {
    type?: string;
    uploadId?: string;
    requestId?: number;
    heapMb?: number;
  };
  if (msg.type === "ready") {
    slot.ready = true;
    pump();
    return;
  }
  if (msg.type === "listen-prep" && msg.uploadId && msg.requestId != null) {
    try {
      listenPrepHandler?.(msg.uploadId);
    } catch (err) {
      console.error(`[extract] listen-prep handoff failed for ${msg.uploadId}`, err);
    }
    if (listenPrepHandler) {
      slot.child.send({ type: "listen-prep-ack", requestId: msg.requestId });
    }
    return;
  }
  if (msg.type === "done" || msg.type === "error") {
    if (msg.type === "error") {
      console.error(
        `[extract] child error for ${slot.uploadId ?? "?"}`,
        message
      );
    }
    slot.uploadId = null;
    const heapMb = Number(msg.heapMb || 0);
    if (heapMb >= recycleHeapMb()) retire(slot);
    pump();
  }
}

function onChildExit(slot: WarmSlot, code: number | null): void {
  const uploadId = slot.uploadId;
  dropSlot(slot);
  if (uploadId && code !== 0) {
    console.error(`[extract] child exited ${code} for ${uploadId}`);
  }
  if (!stopped) ensureSlots();
  pump();
}

function assign(slot: WarmSlot, uploadId: string): void {
  const requestId = nextRequestId++;
  slot.uploadId = uploadId;
  const sent = slot.child.send({ type: "extract", uploadId, requestId });
  if (!sent) {
    slot.uploadId = null;
    queue.unshift(uploadId);
    retire(slot);
    return;
  }
  console.info(`[extract] warm child accepted ${uploadId} pid=${slot.child.pid ?? "?"}`);
  void heartbeatUploadExtract(uploadId).catch(() => {});
}

function pump(): void {
  if (stopped) return;
  while (queue.length > 0) {
    const slot = slots.find((item) => item.ready && !item.uploadId);
    if (!slot) break;
    const uploadId = queue.shift();
    if (!uploadId) break;
    if (slots.some((item) => item.uploadId === uploadId)) continue;
    assign(slot, uploadId);
  }
  if (extractInflightCount() > 0 || queue.length > 0) ensureHeartbeat();
}

/** Fork the pool at boot so the first upload does not pay process startup. */
export function prewarmNodeExtract(): void {
  stopped = false;
  ensureSlots();
}

/**
 * Start or queue an extract. A second call for the same id is a no-op
 * so a Cloudflare fallback and a retry cannot parse twice in this process.
 */
export function startNodeExtract(uploadId: string): {
  started: boolean;
  queued: boolean;
} {
  stopped = false;
  if (
    queue.includes(uploadId) ||
    slots.some((slot) => slot.uploadId === uploadId)
  ) {
    return { started: false, queued: true };
  }
  ensureSlots();
  const slot = slots.find((item) => item.ready && !item.uploadId);
  if (!slot) {
    queue.push(uploadId);
    ensureHeartbeat();
    console.info(`[extract] queued ${uploadId} ahead=${queue.length}`);
    return { started: false, queued: true };
  }
  assign(slot, uploadId);
  ensureHeartbeat();
  return { started: true, queued: false };
}

export function stopNodeExtracts(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  queue.length = 0;
  for (const slot of slots) {
    slot.child.removeAllListeners("exit");
    slot.child.kill("SIGTERM");
  }
  slots.length = 0;
}
