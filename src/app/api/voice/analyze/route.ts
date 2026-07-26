import { NextRequest, NextResponse } from "next/server";
import { analyzeVoiceSample } from "@/lib/voice-quality-checker";
import { AppError, handleApiError } from "@/lib/errors";
import { createRateLimiter } from "@/lib/rate-limit";

const checkRateLimit = createRateLimiter(3, 60_000);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * POST /api/voice/analyze
 * Analyze a voice sample and return quality report
 */
export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!(await checkRateLimit(ip))) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;

    if (!audioFile) {
      throw new AppError("MISSING_FILE", "No audio file provided", 400);
    }

    // M10: Enforce file size limit
    if (audioFile.size > MAX_FILE_SIZE) {
      throw new AppError("FILE_TOO_LARGE", "Audio file must be under 10MB", 400);
    }

    // Convert File to Buffer
    const bytes = await audioFile.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Analyze the voice sample
    const report = await analyzeVoiceSample(buffer, audioFile.name);

    return NextResponse.json(report);
  } catch (error) {
    return handleApiError(error);
  }
}
