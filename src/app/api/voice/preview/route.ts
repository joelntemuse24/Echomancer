import { NextRequest, NextResponse } from "next/server";
import { downloadFile, uploadFile, getPublicUrl } from "@/lib/storage";
import { getEnv } from "@/lib/env";
import { AppError, handleApiError } from "@/lib/errors";
import { createRateLimiter } from "@/lib/rate-limit";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const previewSchema = z.object({
  voiceStoragePath: z.string().min(1),
  startTime: z.coerce.number().min(0).max(36000).optional().default(0),
  endTime: z.coerce.number().min(0).max(36000).optional().default(30),
});

const PREVIEW_TEXT = "Hello, this is a preview of how your audiobook will sound. The voice you selected will be used to narrate your entire book.";

const checkPreviewRateLimit = createRateLimiter(3, 60_000);

async function clipAudioBuffer(audioBuffer: Buffer, startTime: number, endTime: number): Promise<Buffer> {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `preview_input_${Date.now()}.audio`);
  const outputPath = path.join(tempDir, `preview_clipped_${Date.now()}.wav`);
  
  try {
    fs.writeFileSync(inputPath, audioBuffer);
    const duration = endTime - startTime;
    
    // Use ffmpeg to clip - mono, 24kHz for TTS
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ss ${startTime} -t ${duration} -ac 1 -ar 24000 "${outputPath}"`;
    
    await execAsync(ffmpegCmd);
    
    return fs.readFileSync(outputPath);
  } finally {
    try {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    } catch {}
  }
}

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

    // Download the voice sample from local storage
    const voiceBuffer = await downloadFile(parsed.voiceStoragePath);
    
    // Clip the audio to the selected time range
    const clipDuration = parsed.endTime - parsed.startTime;
    if (clipDuration < 3) {
      throw new AppError("CLIP_TOO_SHORT", "Voice clip must be at least 3 seconds", 400);
    }
    
    console.log(`[Voice Preview] Clipping audio from ${parsed.startTime}s to ${parsed.endTime}s (${clipDuration}s duration)`);
    const clippedBuffer = await clipAudioBuffer(voiceBuffer, parsed.startTime, parsed.endTime);
    console.log(`[Voice Preview] Clipped audio: ${voiceBuffer.length} → ${clippedBuffer.length} bytes`);
    
    const voiceBase64 = clippedBuffer.toString("base64");

    // Call VoxCPM TTS
    const modalUrl = getEnv().MODAL_TTS_URL;
    if (!modalUrl) {
      throw new AppError("CONFIG_ERROR", "TTS service not configured", 500);
    }

    // Generate preview with VoxCPM (single call, no prompt key needed)
    const generateResponse = await fetch(modalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: PREVIEW_TEXT,
        reference_audio_base64: voiceBase64,
        reference_text: null,
        cfg_value: 2.0,
        inference_timesteps: 10,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!generateResponse.ok) {
      const errText = await generateResponse.text().catch(() => "Unknown error");
      if (generateResponse.status === 422) {
        throw new AppError("TTS_VALIDATION_ERROR", `TTS request validation failed: ${errText.slice(0, 200)}`, 400);
      }
      if (generateResponse.status === 504) {
        throw new AppError("TTS_TIMEOUT", "Voice synthesis service is starting up. Please try again in a few minutes.", 504);
      }
      throw new AppError("TTS_FAILED", `Voice preview generation failed: ${errText}`, 502);
    }

    const result = await generateResponse.json();
    if (result.error) {
      throw new AppError("TTS_ERROR", result.error, 502);
    }
    if (!result.audio_base64) {
      throw new AppError("NO_AUDIO", "No audio returned from TTS service", 502);
    }

    // Upload preview audio to local storage
    // Include time range in filename to avoid caching issues
    const previewFilename = `${parsed.voiceStoragePath.replace(/\//g, "_")}_${parsed.startTime}s-${parsed.endTime}s_preview.mp3`;
    const previewPath = `previews/${previewFilename}`;
    const audioBuffer = Buffer.from(result.audio_base64, "base64");

    await uploadFile("previews", previewFilename, audioBuffer, "audio/mpeg");

    return NextResponse.json({
      previewUrl: getPublicUrl(previewPath),
      duration: result.duration_seconds || 5,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
