/**
 * Dispatch document text extraction to Trigger.dev. Vercel never downloads
 * the source file on the upload request path.
 */

import { AppError } from "@/lib/errors";
import { triggerTask } from "@/lib/jobs/trigger-api";
import { isProductionDispatch } from "@/lib/jobs/trigger-takehome";
import { markUploadExtractEnqueued } from "@/lib/turso/uploads";
import { extractUploadedDocument } from "@/lib/uploads/extract";

export const UPLOAD_EXTRACT_TASK_ID = "upload.extract";

const TRIGGER_MISSING_MESSAGE =
  "Document processing is not configured (TRIGGER_SECRET_KEY is missing).";

const TRIGGER_DISPATCH_MESSAGE =
  "Document processing could not be started. Please try again.";

export function assertCanDispatchExtract(): void {
  if (!isProductionDispatch()) return;
  if (!process.env.TRIGGER_SECRET_KEY?.trim()) {
    throw new AppError(
      "TRIGGER_NOT_CONFIGURED",
      TRIGGER_MISSING_MESSAGE,
      503
    );
  }
}

/**
 * Production: fire `upload.extract` immediately. SDK / REST failures throw
 * (complete surfaces 503). Tests / local without a Trigger key: extract
 * in-process from storage.
 */
export async function dispatchUploadExtract(
  uploadId: string
): Promise<"enqueued" | "inline"> {
  const key = process.env.TRIGGER_SECRET_KEY?.trim();
  if (key) {
    await enqueueUploadExtract(uploadId);
    return "enqueued";
  }
  if (isProductionDispatch()) {
    throw new AppError(
      "TRIGGER_NOT_CONFIGURED",
      TRIGGER_MISSING_MESSAGE,
      503
    );
  }
  await extractUploadedDocument(uploadId);
  return "inline";
}

export async function enqueueUploadExtract(
  uploadId: string,
  options: { restAttempts?: number } = {}
): Promise<{ id: string } | null> {
  const key = process.env.TRIGGER_SECRET_KEY?.trim();
  if (!key) {
    if (isProductionDispatch()) {
      throw new AppError(
        "TRIGGER_NOT_CONFIGURED",
        TRIGGER_MISSING_MESSAGE,
        503
      );
    }
    return null;
  }

  try {
    const handle = await triggerTask(
      UPLOAD_EXTRACT_TASK_ID,
      { uploadId },
      {
        concurrencyKey: uploadId,
        restAttempts: options.restAttempts,
      }
    );
    await markUploadExtractEnqueued(uploadId);
    console.info(
      `[upload.extract] enqueued upload ${uploadId} run ${handle.id}`
    );
    return handle;
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "TRIGGER_DISPATCH_FAILED") {
        throw new AppError(
          "TRIGGER_DISPATCH_FAILED",
          TRIGGER_DISPATCH_MESSAGE,
          503
        );
      }
      throw err;
    }
    console.error(`[upload.extract] Trigger dispatch failed for ${uploadId}`, err);
    throw new AppError(
      "TRIGGER_DISPATCH_FAILED",
      TRIGGER_DISPATCH_MESSAGE,
      503
    );
  }
}

/** Poll path: re-fire extract if complete's enqueue was lost. Never throws. */
export async function nudgeUploadExtract(uploadId: string): Promise<void> {
  try {
    await enqueueUploadExtract(uploadId, { restAttempts: 1 });
  } catch (err) {
    console.error(
      `[upload.extract] poll nudge failed for ${uploadId}; drain remains the safety net`,
      err
    );
  }
}
