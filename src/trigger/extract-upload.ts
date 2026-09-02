/**
 * Trigger.dev host for document text extraction.
 *
 * The browser PUTs source bytes to R2. This task downloads from storage,
 * runs extractTextFromDocument, writes content.txt, and marks the upload ready.
 * Vercel never buffers the file.
 */

import { schedules, task } from "@trigger.dev/sdk";
import { assertExtractWorkerSecrets } from "@/lib/jobs/trigger-secrets";
import { listDrainableExtractUploads } from "@/lib/turso/uploads";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { extractUploadedDocument } from "@/lib/uploads/extract";

export const uploadExtract = task({
  id: "upload.extract",
  maxDuration: 3600,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async (payload: { uploadId: string }) => {
    assertExtractWorkerSecrets();
    await ensureTtsJobColumns();
    const uploadId = payload?.uploadId;
    if (!uploadId || typeof uploadId !== "string") {
      throw new Error("upload.extract requires { uploadId }");
    }
    const result = await extractUploadedDocument(uploadId);
    if (result.status === "failed") {
      // Permanent (scanned PDF, too little text) — do not retry.
      return result;
    }
    return result;
  },
});

export const uploadDrain = schedules.task({
  id: "upload.drain",
  cron: "* * * * *",
  run: async () => {
    assertExtractWorkerSecrets();
    await ensureTtsJobColumns();
    const ids = [...new Set(await listDrainableExtractUploads())];
    for (const uploadId of ids) {
      await uploadExtract.trigger(
        { uploadId },
        { concurrencyKey: uploadId }
      );
    }
    return { triggered: ids.length, uploadIds: ids };
  },
});
