/**
 * Always-on Whole-book host. Vercel POSTs `{ jobId }` here; this process
 * imports `runTakehomeUntilSettled` in-process (same as takehome.advance).
 * Document extract does not run here.
 */

import { config as loadEnv } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.worker" });
loadEnv();

import { assertTakehomeWorkerSecrets } from "@/lib/jobs/trigger-secrets";
import {
  DEFAULT_TRIGGER_WAVE_BUDGET_MS,
  listDrainableTakehomeJobs,
  releaseExpiredTakehomeLeases,
  runTakehomeUntilSettled,
} from "@/lib/tts/process-job";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { workerSharedSecret } from "@/worker/auth";
import { routeTakehomeWorkerRequest } from "@/worker/takehome-http";
import { TakehomeWorkerLoop } from "@/worker/takehome-loop";

const PORT = Number(process.env.WORKER_PORT || "8788");
const HOST = process.env.WORKER_HOST?.trim() || "0.0.0.0";
const DRAIN_INTERVAL_MS = Number(process.env.WORKER_DRAIN_INTERVAL_MS || "15000");
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || "2");
const WAVE_BUDGET_MS = Number(
  process.env.TTS_VM_WAVE_BUDGET_MS ||
    process.env.TTS_TRIGGER_WAVE_BUDGET_MS ||
    DEFAULT_TRIGGER_WAVE_BUDGET_MS
);

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function tursoReady(): Promise<boolean> {
  try {
    const { queryOne } = await import("@/lib/turso");
    const row = await queryOne<{ ok: number }>("SELECT 1 as ok");
    return row?.ok === 1;
  } catch (err) {
    console.error("[takehome-worker] Turso ready check failed", err);
    return false;
  }
}

async function main(): Promise<void> {
  if (!workerSharedSecret()) {
    throw new Error(
      "Take-home worker missing WORKER_SECRET or INTERNAL_JOB_SECRET"
    );
  }
  assertTakehomeWorkerSecrets();
  await ensureTtsJobColumns();

  const startedAt = Date.now();
  const loop = new TakehomeWorkerLoop({
    concurrency: Number.isFinite(CONCURRENCY) ? CONCURRENCY : 2,
    budgetMs: Number.isFinite(WAVE_BUDGET_MS)
      ? WAVE_BUDGET_MS
      : DEFAULT_TRIGGER_WAVE_BUDGET_MS,
    runner: {
      runUntilSettled: runTakehomeUntilSettled,
      listDrainable: listDrainableTakehomeJobs,
      releaseExpired: releaseExpiredTakehomeLeases,
    },
  });

  const server = createServer((req, res) => {
    void handle(req, res, loop, startedAt);
  });

  const drainTimer = setInterval(() => {
    void loop.drain().then((result) => {
      if (result.started.length > 0 || result.released > 0) {
        console.info(
          `[takehome-worker] drain started=${result.started.length} released=${result.released} inflight=${loop.inflightCount}`
        );
      }
    });
  }, Number.isFinite(DRAIN_INTERVAL_MS) ? DRAIN_INTERVAL_MS : 15_000);
  drainTimer.unref?.();

  const shutdown = async (signal: string) => {
    console.info(`[takehome-worker] ${signal} — draining in-flight jobs`);
    loop.stop();
    clearInterval(drainTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await loop.waitIdle(30_000);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  server.listen(PORT, HOST, () => {
    console.info(
      `[takehome-worker] listening on http://${HOST}:${PORT} concurrency=${loop.concurrency}`
    );
    void loop.drain();
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  loop: TakehomeWorkerLoop,
  startedAt: number
): Promise<void> {
  try {
    const bodyText =
      req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";
    const result = await routeTakehomeWorkerRequest({
      method: req.method || "GET",
      url: req.url || "/",
      authorization: header(req, "authorization"),
      workerSecret: header(req, "x-worker-secret"),
      internalSecret: header(req, "x-internal-secret"),
      bodyText,
      loop,
      startedAt,
      ready: tursoReady,
    });
    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      ...result.headers,
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (err) {
    console.error("[takehome-worker] request failed", err);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Internal error" }));
  }
}

main().catch((err) => {
  console.error("[takehome-worker] failed to start", err);
  process.exit(1);
});
