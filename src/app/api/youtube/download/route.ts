import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const videoId = body.videoId?.trim();
    const startTime = body.startTime ?? 0;
    const endTime = body.endTime ?? 30;

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new AppError("INVALID_VIDEO_ID", "A valid YouTube video ID is required", 400);
    }

    if (endTime <= startTime) {
      throw new AppError("INVALID_RANGE", "End time must be greater than start time", 400);
    }

    // Call Modal YouTube download endpoint
    const modalBaseUrl = process.env.MODAL_TTS_URL;
    if (!modalBaseUrl) {
      throw new AppError("CONFIG_MISSING", "MODAL_TTS_URL not configured", 500);
    }

    // Derive the YouTube download URL from the TTS URL
    // TTS URL: https://ntemusejoel--zonos-tts-v2-zonosserver-generate.modal.run
    // YT URL:  https://ntemusejoel--zonos-tts-download-youtube-audio.modal.run
    const ytDownloadUrl = modalBaseUrl
      .replace(/zonosserver-generate/, "download-youtube-audio");

    console.log(`[YouTube Download] Requesting video ${videoId} (${startTime}s-${endTime}s) from ${ytDownloadUrl}`);

    const modalResponse = await fetch(ytDownloadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: videoId,
        start_time: startTime,
        end_time: endTime,
      }),
      signal: AbortSignal.timeout(120_000), // 2 minute timeout
    });

    if (!modalResponse.ok) {
      const errorText = await modalResponse.text();
      throw new AppError(
        "MODAL_ERROR",
        `YouTube download failed (${modalResponse.status}): ${errorText.slice(0, 200)}`,
        502
      );
    }

    const result = await modalResponse.json();

    if (result.error) {
      throw new AppError("DOWNLOAD_FAILED", result.error, 500);
    }

    if (!result.audio_base64) {
      throw new AppError("NO_AUDIO", "No audio returned from download", 500);
    }

    // Upload the downloaded audio to Supabase storage
    const supabase = createServerClient();
    const fileId = randomUUID();
    const storagePath = `voices/${fileId}/youtube_${videoId}.wav`;

    const audioBuffer = Buffer.from(result.audio_base64, "base64");

    const { error: uploadError } = await supabase.storage
      .from("audiobooks")
      .upload(storagePath, audioBuffer, {
        contentType: "audio/wav",
        upsert: false,
      });

    if (uploadError) {
      throw new AppError("UPLOAD_FAILED", `Failed to store audio: ${uploadError.message}`, 500);
    }

    console.log(`[YouTube Download] Stored ${audioBuffer.length} bytes at ${storagePath}`);

    return NextResponse.json({
      storagePath,
      format: result.format || "wav",
      size: audioBuffer.length,
      durationSeconds: result.duration_seconds,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
