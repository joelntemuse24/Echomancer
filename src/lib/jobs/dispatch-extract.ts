/**
 * Start document extract near the request. Every document goes to the
 * always-on Node worker when `WORKER_URL` is set. The Cloudflare extract
 * Worker is the fallback when that POST is unreachable or the worker
 * reports itself unhealthy. Without either host, tests/local extract
 * in-process and production uses Next `after()`. This module never
 * enqueues `upload.extract` on Trigger.
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
 * 503 when the worker is unhealthy), fall back to Cloudflare. Returns which
 * host accepted the job.
 */
async function dispatchNodeOrCloudflare(
  uploadId: string
): Promise<"node" | "worker"> {
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
    if (isExtractWorkerConfigured()) {
      await enqueueExtractWorker(uploadId);
      return "worker";
    }
    throw err;
  }
}

/**
 * Node worker when it is configured, any format and any size. Cloudflare
 * only when Node is not configured, or when the Node POST fails. Tests and
 * local dev with neither host extract inline.
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
    try {
      return await dispatchNodeOrCloudflare(uploadId);
    } catch (err) {
      if (!isProductionDispatch()) {
        await extractUploadedDocument(uploadId, { host: "inline" });
        return "inline";
      }
      if (err instanceof AppError) throw err;
      throw new AppError(
        "EXTRACT_WORKER_FAILED",
        WORKER_DISPATCH_MESSAGE,
        503
      );
    }
  }

  if (target === "cloudflare") {
    await enqueueExtractWorker(uploadId);
    return "worker";
  }

  if (!isProductionDispatch()) {
    await extractUploadedDocument(uploadId, { host: "inline" });
    return "inline";
  }

  if (bytes > 0 && bytes <= VERCEL_INLINE_EXTRACT_MAX_BYTES) {
    await extractUploadedDocument(uploadId, { host: "inline" });
    return "inline";
  }

  await markUploadExtracting(uploadId);
  scheduleVercelExtract(uploadId);
  return "vercel";
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
 * Status poll. Hands a stalled Cloudflare fallback back to Node, retries a
 * Node worker that stopped heartbeating, and fails the row after the cap.
 * Never throws. Never Trigger.
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
      console.info(`[extract] gave up on upload ${uploadId}`);
      return true;
    }
    if (decision.target === "node" && isTakehomeWorkerConfigured()) {
      await dispatchNodeOrCloudflare(uploadId);
      return true;
    }
    if (isExtractWorkerConfigured()) {
      await enqueueExtractWorker(uploadId);
      return true;
    }
    if (!isProductionDispatch()) {
      await extractUploadedDocument(uploadId, { host: "inline" });
    }
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
