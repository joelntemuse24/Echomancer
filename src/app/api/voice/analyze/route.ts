import { NextRequest, NextResponse } from "next/server";
import { analyzeVoiceSample } from "@/lib/voice-quality-checker";
import { AppError, handleApiError } from "@/lib/errors";

/**
 * POST /api/voice/analyze
 * Analyze a voice sample and return quality report
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;

    if (!audioFile) {
      throw new AppError("MISSING_FILE", "No audio file provided", 400);
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
