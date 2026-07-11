import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ensureUploadCors,
  getUploadUrl,
  isR2Configured,
} from "@/lib/r2-storage";
import { createRateLimiter } from "@/lib/rate-limit";
import { AppError, handleApiError } from "@/lib/errors";
import { ALLOWED_AUDIO_TYPES } from "@/lib/audio-types";

const checkRateLimit = createRateLimiter(10, 60_000);
const requestSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.enum(ALLOWED_AUDIO_TYPES),
  fileSize: z.number().int().min(10_000).max(50 * 1024 * 1024),
});

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkRateLimit(ip)) {
      return NextResponse.json({ error: "Too many upload requests" }, { status: 429 });
    }
    const parsed = requestSchema.parse(await request.json());
    if (!isR2Configured()) {
      return NextResponse.json({ directUpload: false });
    }
    const extension = parsed.fileName.split(".").pop()?.toLowerCase() || "audio";
    const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : "audio";
    const storagePath = `voices/${randomUUID()}/source.${safeExtension}`;
    let corsReady = true;
    await ensureUploadCors().catch((error) => {
      corsReady = false;
      console.warn("[Audio Upload] Could not update R2 CORS policy:", error);
    });
    if (!corsReady) {
      if (parsed.fileSize > 4 * 1024 * 1024) {
        throw new AppError(
          "UPLOAD_CORS_UNAVAILABLE",
          "Large voice uploads are temporarily unavailable",
          503
        );
      }
      return NextResponse.json({ directUpload: false });
    }
    const uploadUrl = await getUploadUrl(storagePath, parsed.contentType);
    return NextResponse.json({ directUpload: true, uploadUrl, storagePath });
  } catch (error) {
    return handleApiError(error);
  }
}
