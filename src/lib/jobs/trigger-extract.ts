/**
 * Dispatch document text extraction to Trigger.dev. Vercel never downloads
 * the source file on the upload request path.
 */

import { AppError } from "@/lib/errors";
import { isProductionDispatch } from "@/lib/jobs/trigger-takehome";
import { extractUploadedDocument } from "@/lib/uploads/extract";

export const UPLOAD_EXTRACT_TASK_ID = "upload.extract";

const TRIGGER_MISSING_MESSAGE =
  "Document processing is not configured (TRIGGER_SECRET_KEY is missing).";

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
 * Production: fire `upload.extract` (drain retries if the SDK call fails).
 * Tests / local without a Trigger key: extract in-process from storage.
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

export async function enqueueUploadExtract(uploadId: string): Promise<void> {
  const key = process.env.TRIGGER_SECRET_KEY?.trim();
  if (!key) {
    if (isProductionDispatch()) {
      console.error(
        `[upload.extract] TRIGGER_SECRET_KEY missing; upload ${uploadId} left uploaded for upload.drain`
      );
    }
    return;
  }

  try {
    const { tasks } = await import("@trigger.dev/sdk");
    await tasks.trigger(
      UPLOAD_EXTRACT_TASK_ID,
      { uploadId },
      { concurrencyKey: uploadId }
    );
  } catch (err) {
    console.error(
      `[upload.extract] Trigger dispatch failed for ${uploadId}; left for upload.drain`,
      err
    );
  }
}
