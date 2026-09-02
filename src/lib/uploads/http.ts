/**
 * Tiny JSON bodies only. A 5MB multipart POST used to hit Vercel
 * FUNCTION_PAYLOAD_TOO_LARGE (~4.5MB) before this function ran.
 */
import { AppError } from "@/lib/errors";
import { VERCEL_FUNCTION_BODY_LIMIT_BYTES } from "@/lib/document-formats";

/** Stay well under the platform cap so JSON routes never get a plaintext 413. */
const JSON_BODY_LIMIT_BYTES = 64 * 1024;

export function rejectOversizedFunctionBody(
  request: Request,
  limitBytes: number = JSON_BODY_LIMIT_BYTES
): void {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > VERCEL_FUNCTION_BODY_LIMIT_BYTES) {
    throw new AppError(
      "FILE_TOO_LARGE",
      "This request is too large for the app server. Documents upload directly to storage — send only JSON here.",
      413
    );
  }
  if (declaredLength > limitBytes) {
    throw new AppError(
      "FILE_TOO_LARGE",
      "This request is too large. Send only JSON metadata, not the document bytes.",
      413
    );
  }
}

export function rejectMultipartUpload(request: Request): void {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    throw new AppError(
      "USE_PRESIGN",
      "Do not POST the document through this server. Request a storage URL with JSON { fileName, contentType, byteSize }, PUT the file there, then complete the upload.",
      400
    );
  }
}
