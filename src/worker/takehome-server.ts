/**
 * Always-on Whole-book host. Vercel POSTs `{ jobId }` here; this process
 * imports `runTakehomeUntilSettled` in-process (same as takehome.advance).
 * Document extract does not run here.
 */

import "@/worker/load-env";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { queryOne } from "@/lib/turso";
import { assertTakehomeWorkerSecrets } from "@/lib/jobs/trigger-secrets";
import {
  DEFAULT_TRIGGER_WAVE_BUDGET_MS,
  listDrainableTakehomeJobs,
  releaseExpiredTakehomeLeases,
  runTakehomeUntilSettled,
} from "@/lib/tts/process-job";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { workerSharedSecret } from "@/worker/auth";
import { prepareUploadForListening } from "@/lib/tts/listen-prep-cache";
import { routeTakehomeWorkerRequest } from "@/worker/takehome-http";
import { TakehomeWorkerLoop } from "@/worker/takehome-loop";
import { scratchSweepIntervalMs, sweepStaleJobScratch } from "@/lib/tts/job-scratch";

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

/** Reject oversized bodies before auth so an open port cannot OOM the box. */
const MAX_BODY_BYTES = 16 * 1024;

async function readBody(
  req: IncomingMessage
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return { ok: false, status: 413 };
    }
    chunks.push(buf);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

async function acceptTakehomeJob(
  jobId: string
): Promise<"ok" | "missing" | "wrong-kind"> {
  const row = await queryOne<{ job_kind: string | null }>(
    `SELECT job_kind FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );
  if (!row) return "missing";
  if (row.job_kind && row.job_kind !== "takehome") return "wrong-kind";
  return "ok";
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

  void sweepStaleJobScratch().catch((err) => {
    console.error("[takehome-worker] scratch sweep failed", err);
  });
  const scratchTimer = setInterval(() => {
    void sweepStaleJobScratch().catch((err) => {
      console.error("[takehome-worker] scratch sweep failed", err);
    });
  }, scratchSweepIntervalMs());
  scratchTimer.unref?.();

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
    clearInterval(scratchTimer);
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
    let bodyText = "";
    if (req.method === "POST" || req.method === "PUT") {
      const body = await readBody(req);
      if (!body.ok) {
        res.writeHead(body.status, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
        return;
      }
      bodyText = body.text;
    }
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
      acceptJob: acceptTakehomeJob,
      startListenPrep: (uploadId) => {
        void prepareUploadForListening(uploadId).catch((err) => {
          console.warn(
            `[takehome-worker] listen-prep failed for ${uploadId}`,
            err instanceof Error ? err.message : err
          );
        });
      },
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
