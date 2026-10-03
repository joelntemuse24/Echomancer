/**
 * Document extract child. The parent keeps a warm process and sends
 * `{ type: "extract", uploadId, requestId }` over IPC. Heavy imports load
 * once, before the child reports ready, so a tiny file does not pay Node
 * startup again.
 *
 * Listen-prep is handed to the parent and that ack is awaited before the
 * child reports done. A one-shot `tsx extract-child.ts <uploadId>` (no
 * IPC) awaits the kick in this process, then exits.
 */

import "@/worker/load-env";
import { requestListenPrepHandoff } from "@/worker/extract-ipc";

interface ExtractCommand {
  type: "extract";
  uploadId: string;
  requestId: number;
}

interface AckCommand {
  type: "listen-prep-ack";
  requestId: number;
}

type Inbound = ExtractCommand | AckCommand | { type: "shutdown" };

const acks = new Map<number, () => void>();
let loaded = false;
let running = false;
let pending: ExtractCommand | null = null;

function send(message: unknown): boolean {
  if (typeof process.send !== "function") return false;
  try {
    return process.send(message) !== false;
  } catch {
    return false;
  }
}

async function handoffListenPrep(
  uploadId: string,
  requestId: number
): Promise<void> {
  if (typeof process.send !== "function") {
    const { awaitListenPrepKick } = await import("@/lib/tts/listen-prep-cache");
    await awaitListenPrepKick(uploadId);
    return;
  }
  await requestListenPrepHandoff({
    uploadId,
    requestId,
    send: (message) => send(message),
    onAck: (id, settle) => {
      acks.set(id, settle);
    },
    fallback: async (id) => {
      const { awaitListenPrepKick } = await import("@/lib/tts/listen-prep-cache");
      await awaitListenPrepKick(id);
    },
  });
}

async function runExtract(command: ExtractCommand): Promise<void> {
  running = true;
  try {
    const { extractUploadedDocument } = await import("@/lib/uploads/extract");
    const view = await extractUploadedDocument(command.uploadId, {
      host: "node",
      listenPrep: (id) => handoffListenPrep(id, command.requestId),
    });
    const heapMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    send({
      type: "done",
      requestId: command.requestId,
      status: view.status,
      charCount: view.charCount,
      heapMb,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[extract] ${command.uploadId} crashed`, err);
    send({ type: "error", requestId: command.requestId, message });
  } finally {
    running = false;
  }
}

function onMessage(msg: Inbound): void {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  if (msg.type === "listen-prep-ack") {
    const settle = acks.get(msg.requestId);
    acks.delete(msg.requestId);
    settle?.();
    return;
  }
  if (msg.type !== "extract") return;
  if (!loaded || running) {
    pending = msg;
    return;
  }
  void runExtract(msg);
}

async function warm(): Promise<void> {
  await import("@/lib/uploads/extract");
  loaded = true;
  send({ type: "ready" });
  if (pending && !running) {
    const command = pending;
    pending = null;
    await runExtract(command);
  }
}

const oneShot = process.argv[2] || "";
if (oneShot && typeof process.send !== "function") {
  void runExtract({ type: "extract", uploadId: oneShot, requestId: 1 }).then(
    () => process.exit(0)
  );
} else if (!oneShot && typeof process.send !== "function") {
  console.error("[extract] uploadId required");
  process.exit(2);
} else {
  process.on("message", (msg) => onMessage(msg as Inbound));
  void warm().catch((err) => {
    console.error("[extract] child failed to load", err);
    process.exit(1);
  });
}
