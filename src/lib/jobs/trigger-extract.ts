/**
 * @deprecated Extract no longer uses Trigger. Kept so existing imports
 * compile. Dispatch lives in `dispatch-extract.ts`.
 */

export {
  dispatchUploadExtract,
  nudgeUploadExtract,
} from "@/lib/jobs/dispatch-extract";

/** Uploads no longer require Trigger. Whole-book TTS still does. */
export function assertCanDispatchExtract(): void {
  return;
}

export const UPLOAD_EXTRACT_TASK_ID = "upload.extract";

export function uploadExtractIdempotencyKey(uploadId: string): string {
  return `upload-extract:${uploadId}`;
}
