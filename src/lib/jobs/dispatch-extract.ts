/**
 * Start document extract near the request. Happy path is a Cloudflare
 * Worker (R2 + Turso, fast cold start). Without EXTRACT_WORKER_URL,
 * tests/local extract in-process and production uses Next `after()`.
 * Whole-book TTS stays on Trigger — this module never enqueues
 * `upload.extract`.
 */

import { after } from "next/server";
import { AppError } from "@/lib/errors";
import { isProductionDispatch } from "@/lib/jobs/trigger-takehome";
import { getUploadById, markUploadExtracting } from "@/lib/turso/uploads";
import { extractUploadedDocument } from "@/lib/uploads/extract";

/** Vercel complete can finish a small parse in-request if Workers is unset. */
export const VERCEL_INLINE_EXTRACT_MAX_BYTES = 8 * 1024 * 1024;

const WORKER_DISPATCH_MESSAGE =
  "Document processing could not be started. Please try again.";

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

  await markUploadExtracting(uploadId);

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
 * Production + Worker: POST and return. Tests/local: extract inline.
 * Production without Worker: small docs inline (Joel: Vercel sync fallback),
 * larger files via `after()` + GET nudge.
 */
export async function dispatchUploadExtract(
  uploadId: string
): Promise<"worker" | "inline" | "vercel"> {
  if (isExtractWorkerConfigured()) {
    await enqueueExtractWorker(uploadId);
    return "worker";
  }

  if (!isProductionDispatch()) {
    await extractUploadedDocument(uploadId);
    return "inline";
  }

  const row = await getUploadById(uploadId);
  const bytes = Number(row?.byte_size || 0);
  if (bytes > 0 && bytes <= VERCEL_INLINE_EXTRACT_MAX_BYTES) {
    await extractUploadedDocument(uploadId);
    return "inline";
  }

  await markUploadExtracting(uploadId);
  scheduleVercelExtract(uploadId);
  return "vercel";
}

/** Poll path: re-fire Worker / Vercel extract. Never throws. Never Trigger. */
export async function nudgeUploadExtract(uploadId: string): Promise<void> {
  try {
    await dispatchUploadExtract(uploadId);
  } catch (err) {
    console.error(
      `[extract] poll nudge failed for ${uploadId}`,
      err
    );
  }
}
