import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getEnv } from "@/lib/env";
import { AppError, handleApiError } from "@/lib/errors";
import { createRateLimiter } from "@/lib/rate-limit";
import { z } from "zod";

const previewSchema = z.object({
  voiceStoragePath: z.string().min(1),
  startTime: z.number().min(0).max(30).optional().default(0),
  endTime: z.number().min(0).max(30).optional().default(30),
});

const PREVIEW_TEXT = "Hello, this is a preview of how your audiobook will sound. The voice you selected will be used to narrate your entire book.";

const checkPreviewRateLimit = createRateLimiter(3, 60_000);

export async function POST(request: NextRequest) {
  try {
    // Rate limit — GPU preview calls are expensive
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkPreviewRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many preview requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = previewSchema.parse(body);

    const supabase = createServerClient();

    // Download the voice sample from Supabase storage
    const { data: voiceData, error: downloadError } = await supabase.storage
      .from("audiobooks")
      .download(parsed.voiceStoragePath);

    if (downloadError || !voiceData) {
      throw new AppError("DOWNLOAD_FAILED", "Could not download voice sample for preview", 500);
    }

    const voiceBuffer = Buffer.from(await voiceData.arrayBuffer());
    const voiceBase64 = voiceBuffer.toString("base64");

    // Call Modal TTS single-generate endpoint
    const modalUrl = getEnv().MODAL_TTS_URL;
    if (!modalUrl) {
      throw new AppError("CONFIG_ERROR", "TTS service not configured", 500);
    }

    const response = await fetch(modalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: PREVIEW_TEXT,
        reference_audio_base64: voiceBase64,
        speed: 1.0,
        format: "mp3",
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      throw new AppError("TTS_FAILED", `Voice preview generation failed: ${errText}`, 502);
    }

    const result = await response.json();
    if (result.error) {
      throw new AppError("TTS_ERROR", result.error, 502);
    }
    if (!result.audio_base64) {
      throw new AppError("NO_AUDIO", "No audio returned from TTS service", 502);
    }

    // Upload preview audio to Supabase (temporary — will be overwritten on next preview)
    const previewPath = `previews/${parsed.voiceStoragePath.replace(/\//g, "_")}_preview.mp3`;
    const audioBuffer = Buffer.from(result.audio_base64, "base64");

    const { error: uploadError } = await supabase.storage
      .from("audiobooks")
      .upload(previewPath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) {
      throw new AppError("UPLOAD_FAILED", "Failed to store preview audio", 500);
    }

    const { data: urlData } = supabase.storage
      .from("audiobooks")
      .getPublicUrl(previewPath);

    return NextResponse.json({
      previewUrl: urlData?.publicUrl || null,
      duration: result.sample_rate ? Math.round(audioBuffer.length / (result.sample_rate * 2)) : 5,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
