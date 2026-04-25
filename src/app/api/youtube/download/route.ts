import { NextRequest, NextResponse } from "next/server";
import { uploadFile } from "@/lib/storage";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import play from "play-dl";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

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

    const clipDuration = endTime - startTime;
    if (clipDuration < 3) {
      throw new AppError("CLIP_TOO_SHORT", "Clip must be at least 3 seconds", 400);
    }
    if (clipDuration > 30) {
      throw new AppError("CLIP_TOO_LONG", "Clip must be 30 seconds or less", 400);
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const tempDir = os.tmpdir();
    const fileId = randomUUID();
    const rawPath = path.join(tempDir, `yt_${fileId}_raw.mp4`);
    const clippedPath = path.join(tempDir, `yt_${fileId}_clipped.wav`);

    try {
      console.log(`[YouTube Download] Downloading video ${videoId} with play-dl...`);

      // Get video info first, then stream
      const videoInfo = await play.video_info(videoUrl);
      const stream = await play.stream_from_info(videoInfo, { quality: 140 }); // Audio only
      
      // Save to temp file
      const chunks: Buffer[] = [];
      for await (const chunk of stream.stream) {
        chunks.push(chunk);
      }
      const audioBuffer = Buffer.concat(chunks);
      fs.writeFileSync(rawPath, audioBuffer);

      console.log(`[YouTube Download] Downloaded ${audioBuffer.length} bytes, clipping ${startTime}s-${endTime}s...`);

      // Use ffmpeg to extract the clip and convert to proper format
      const ffmpegCmd = `ffmpeg -y -i "${rawPath}" -ss ${startTime} -t ${clipDuration} -ac 1 -ar 24000 "${clippedPath}"`;
      await execAsync(ffmpegCmd);

      // Read the clipped file
      const clippedBuffer = fs.readFileSync(clippedPath);

      console.log(`[YouTube Download] Clipped audio: ${audioBuffer.length} → ${clippedBuffer.length} bytes`);

      // Upload to local storage
      const filename = `youtube_${videoId}_${startTime}s-${endTime}s.wav`;
      const uploadResult = await uploadFile(`voices/${fileId}`, filename, clippedBuffer, "audio/wav");

      console.log(`[YouTube Download] Stored at ${uploadResult.path}`);

      return NextResponse.json({
        storagePath: uploadResult.path,
        format: "wav",
        size: clippedBuffer.length,
        durationSeconds: clipDuration,
      });
    } finally {
      // Cleanup temp files
      try { fs.unlinkSync(rawPath); } catch {}
      try { fs.unlinkSync(clippedPath); } catch {}
    }
  } catch (error) {
    console.error("[YouTube Download] Error:", error);
    return handleApiError(error);
  }
}
