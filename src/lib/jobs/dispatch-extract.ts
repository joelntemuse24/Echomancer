/**
 * Start document extract near the request. Every document goes to the
 * always-on Node worker when `WORKER_URL` is set. The Cloudflare extract
 * Worker is next when that POST is unreachable or the worker reports
 * itself unhealthy. Vercel is the last resort (inline for a small file,
 * `after()` otherwise), then the stall cap fails the row. This module
 * never enqueues `upload.extract` on Trigger.
 */

import { after } from "next/server";
import { AppError } from "@/lib/errors";
import {
  enqueueExtractOnWorker,
  isTakehomeWorkerConfigured,
} from "@/lib/jobs/takehome-worker-client";
import { isProductionDispatch } from "@/lib/jobs/trigger-takehome";
import {
  claimExtractAdvance,
  failUploadExtract,
  getUploadById,
  markUploadExtracting,
} from "@/lib/turso/uploads";
import { releaseWaitingTakehomesForUpload } from "@/lib/jobs/release-waiting-takehomes";
import { extractUploadedDocument } from "@/lib/uploads/extract";
import {
  chooseInitialExtractTarget,
  decideExtractNudge,
  extractRouteConfig,
  EXTRACT_STUCK_MESSAGE,
} from "@/lib/uploads/extract-route";

/** Vercel complete can finish a small parse in-request if Workers is unset. */
export const VERCEL_INLINE_EXTRACT_MAX_BYTES = 8 * 1024 * 1024;

const WORKER_DISPATCH_MESSAGE =
  "Couldn't start reading. Try again.";

export function extractWorkerUrl(): string | undefined {
  const raw = process.env.EXTRACT_WORKER_URL?.trim();
  return raw || undefined;
}

export function extractWorkerSecret(): string | undefined {
  return (
    process.env.EXTRACT_WORKER_SECRET?.trim() ||
    process.env.INTERNAL_JOB_SECRET?.trim() ||
    undefined
  );
}

export function isExtractWorkerConfigured(): boolean {
  return Boolean(extractWorkerUrl() && extractWorkerSecret());
}

async function enqueueExtractWorker(uploadId: string): Promise<void> {
  const url = extractWorkerUrl();
  const secret = extractWorkerSecret();
  if (!url || !secret) {
    throw new AppError(
      "EXTRACT_WORKER_NOT_CONFIGURED",
      "Document processing is not configured (EXTRACT_WORKER_URL is missing).",
      503
    );
  }

  await markUploadExtracting(uploadId, "cloudflare");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadId }),
    });
  } catch (err) {
    console.error(`[extract] Worker fetch failed for ${uploadId}`, err);
    throw new AppError(
      "EXTRACT_WORKER_FAILED",
      WORKER_DISPATCH_MESSAGE,
      503
    );
  }

  if (res.status < 200 || res.status > 202) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[extract] Worker rejected upload ${uploadId} (${res.status}) ${detail.slice(0, 200)}`
    );
    throw new AppError(
      "EXTRACT_WORKER_FAILED",
      WORKER_DISPATCH_MESSAGE,
      503
    );
  }

  console.info(`[extract] Worker accepted upload ${uploadId}`);
}

function scheduleVercelExtract(uploadId: string): void {
  after(() => {
    void extractUploadedDocument(uploadId).catch((err) => {
      console.error(`[extract] vercel after() failed for ${uploadId}`, err);
    });
  });
}

/**
 * POST the Node worker. On a network error, timeout, or non-2xx (including
 * 503 when the worker is unhealthy), try Cloudflare. Returns null when
 * neither host accepted the job so the caller can use Vercel.
 */
async function dispatchNodeOrCloudflare(
  uploadId: string
): Promise<"node" | "worker" | null> {
  try {
    await markUploadExtracting(uploadId, "node");
    await enqueueExtractOnWorker(uploadId);
    console.info(`[extract] Node worker accepted upload ${uploadId}`);
    return "node";
  } catch (err) {
    console.error(
      `[extract] Node worker unreachable for ${uploadId}; trying Cloudflare`,
      err
    );
    if (!isExtractWorkerConfigured()) return null;
    try {
      await enqueueExtractWorker(uploadId);
      return "worker";
    } catch (cfErr) {
      console.error(
        `[extract] Cloudflare rejected upload ${uploadId}`,
        cfErr
      );
      return null;
    }
  }
}

/**
 * Last resort after Node and Cloudflare. Tests and local dev parse
 * in-process. Production parses a small file in-request and schedules
 * `after()` for a larger one. The host is `inline` so the attempt counter
 * still moves.
 */
async function dispatchVercelExtract(
  uploadId: string,
  bytes: number
): Promise<"inline" | "vercel"> {
  if (
    !isProductionDispatch() ||
    (bytes > 0 && bytes <= VERCEL_INLINE_EXTRACT_MAX_BYTES)
  ) {
    await extractUploadedDocument(uploadId, { host: "inline" });
    return "inline";
  }

  await markUploadExtracting(uploadId, "inline");
  scheduleVercelExtract(uploadId);
  return "vercel";
}

/**
 * Node worker when it is configured, any format and any size. Cloudflare
 * when Node is not configured or the Node POST fails. Vercel when both
 * of those fail or neither is configured.
 */
export async function dispatchUploadExtract(
  uploadId: string
): Promise<"node" | "worker" | "inline" | "vercel"> {
  const row = await getUploadById(uploadId);
  const bytes = Number(row?.byte_size || 0);
  const target = chooseInitialExtractTarget({
    byteSize: bytes,
    cfConfigured: isExtractWorkerConfigured(),
    nodeConfigured: isTakehomeWorkerConfigured(),
    production: isProductionDispatch(),
    inlineMaxBytes: VERCEL_INLINE_EXTRACT_MAX_BYTES,
  });

  if (target === "node") {
    const hosted = await dispatchNodeOrCloudflare(uploadId);
    if (hosted) return hosted;
    return dispatchVercelExtract(uploadId, bytes);
  }

  if (target === "cloudflare") {
    try {
      await enqueueExtractWorker(uploadId);
      return "worker";
    } catch (err) {
      console.error(
        `[extract] Cloudflare rejected upload ${uploadId}; trying Vercel`,
        err
      );
      return dispatchVercelExtract(uploadId, bytes);
    }
  }

  return dispatchVercelExtract(uploadId, bytes);
}

function nudgeInput(row: {
  status: string | null;
  extract_host?: string | null;
  extract_attempts?: number | null;
  extract_started_at: number | null;
  extract_accepted_at?: number | null;
}) {
  return {
    status: row.status || "",
    extractHost: row.extract_host ?? null,
    extractAttempts: Number(row.extract_attempts || 0),
    extractStartedAt:
      row.extract_started_at == null ? null : Number(row.extract_started_at),
    extractAcceptedAt:
      row.extract_accepted_at == null ? null : Number(row.extract_accepted_at),
    now: Math.floor(Date.now() / 1000),
    nodeConfigured: isTakehomeWorkerConfigured(),
    cfConfigured: isExtractWorkerConfigured(),
  };
}

/**
 * Status poll and the player job poll. Node, then Cloudflare, then Vercel,
 * then fail. One attempt counter and the 20-minute cap. Never throws.
 * Never Trigger.
 */
export async function advanceStuckExtract(uploadId: string): Promise<boolean> {
  try {
    const row = await getUploadById(uploadId);
    if (!row) return false;
    const decision = decideExtractNudge(nudgeInput(row), extractRouteConfig());
    if (decision.action === "wait") return false;
    const started =
      row.extract_started_at == null ? null : Number(row.extract_started_at);
    if (!(await claimExtractAdvance(uploadId, started))) return false;
    if (decision.action === "fail") {
      await failUploadExtract(
        uploadId,
        decision.message || EXTRACT_STUCK_MESSAGE,
        row.extract_host
      );
      await releaseWaitingTakehomesForUpload(uploadId).catch((err) => {
        console.error(
          `[extract] waiting take-homes stayed parked for ${uploadId}`,
          err instanceof Error ? err.message : err
        );
      });
      console.info(`[extract] gave up on upload ${uploadId}`);
      return true;
    }
    if (decision.target === "node" && isTakehomeWorkerConfigured()) {
      const hosted = await dispatchNodeOrCloudflare(uploadId);
      if (hosted) return true;
    } else if (decision.target === "cloudflare" && isExtractWorkerConfigured()) {
      try {
        await enqueueExtractWorker(uploadId);
        return true;
      } catch (err) {
        console.error(
          `[extract] Cloudflare nudge failed for ${uploadId}; trying Vercel`,
          err
        );
      }
    }
    const latest = await getUploadById(uploadId);
    await dispatchVercelExtract(uploadId, Number(latest?.byte_size || row.byte_size || 0));
    return true;
  } catch (err) {
    console.error(`[extract] poll nudge failed for ${uploadId}`, err);
    return false;
  }
}

/** @deprecated Use `advanceStuckExtract`. Kept so older call sites keep compiling. */
export async function nudgeUploadExtract(uploadId: string): Promise<void> {
  await advanceStuckExtract(uploadId);
}
