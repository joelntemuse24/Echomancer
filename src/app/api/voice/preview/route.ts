import { NextRequest, NextResponse } from "next/server";
import { downloadFile, uploadFile, getPublicUrl } from "@/lib/storage";

export const runtime = "nodejs";
import { resolveTtsRoute } from "@/lib/tts-config";
import { AppError, handleApiError } from "@/lib/errors";
import { createRateLimiter } from "@/lib/rate-limit";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

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

    // Use ffmpeg with array args to prevent command injection
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-y", "-i", inputPath,
        "-ss", String(startTime),
        "-t", String(duration),
        "-vn",
        "-map_metadata", "-1",
        "-ac", "1",
        "-af", "aresample=24000:resampler=soxr:precision=28",
        "-ar", "24000",
        "-c:a", "pcm_s16le",
        outputPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (data) => { stderr += data; });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
      });
      proc.on("error", reject);
    });

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

    // Path validation before downloading
    const pathPattern = /^(voices|previews|audiobooks)\/[a-zA-Z0-9._/-]+$/;
    if (!pathPattern.test(parsed.voiceStoragePath) || parsed.voiceStoragePath.includes("..")) {
      throw new AppError("INVALID_PATH", "Invalid voice storage path", 400);
    }

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

    const modalUrl = resolveTtsRoute("preview").batchUrl;
    if (!modalUrl) {
      throw new AppError("CONFIG_ERROR", "TTS service not configured", 500);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300_000);
    try {
      const previewPayload: Record<string, unknown> = {
        texts: [PREVIEW_TEXT],
        reference_audio_base64: voiceBase64,
        moss_language: process.env.MOSS_TTS_LANGUAGE ?? "English",
        narration_instructions:
          process.env.MOSS_NARRATION_INSTRUCTIONS ??
          "Expressive audiobook narration with natural warmth, varied intonation, and unhurried pacing.",
        sentence_pause_sec: Number(process.env.MOSS_SENTENCE_PAUSE_SEC ?? "0.22"),
        audio_temperature: Number(process.env.MOSS_AUDIO_TEMPERATURE ?? "1.82"),
        audio_top_p: Number(process.env.MOSS_AUDIO_TOP_P ?? "0.8"),
        audio_top_k: Number(process.env.MOSS_AUDIO_TOP_K ?? "25"),
      };

      const generateResponse = await fetch(modalUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(previewPayload),
        signal: controller.signal,
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
      const segment = result.results?.[0];
      if (segment?.error) {
        throw new AppError("TTS_ERROR", segment.error, 502);
      }
      if (!segment?.audio_base64) {
        throw new AppError("NO_AUDIO", "No audio returned from TTS service", 502);
      }

      // Upload preview audio to storage (WAV format from Modal)
      const previewFilename = `${parsed.voiceStoragePath.replace(/\//g, "_")}_${parsed.startTime}s-${parsed.endTime}s_preview.wav`;
      const previewPath = `previews/${previewFilename}`;
      const audioBuffer = Buffer.from(segment.audio_base64, "base64");

      await uploadFile("previews", previewFilename, audioBuffer, "audio/wav");

      return NextResponse.json({
        previewUrl: getPublicUrl(previewPath),
        previewAudio: segment.audio_base64,
        duration: segment.duration_seconds || 5,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    return handleApiError(error);
  }
}
