import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { uploadFile } from "@/lib/storage";

export const runtime = "nodejs";

const ALLOWED_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/x-aac",
  "audio/wma",
  "audio/x-ms-wma",
  "audio/opus",
  "audio/x-opus",
  "audio/aiff",
  "audio/x-aiff",
  "audio/3gpp",
  "audio/3gpp2",
];

const VALID_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "webm", "mp4", "flac", "aac", "wma", "opus", "aiff", "aif", "3gp", "amr"];

// Max 10MB for voice samples
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      throw new AppError("MISSING_FILE", "No file provided", 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB. Please upload a shorter voice sample (15-30 seconds).`,
        400
      );
    }

    if (file.size === 0) {
      throw new AppError("EMPTY_FILE", "File is empty", 400);
    }

    // Reject files too small to contain meaningful audio
    const MIN_FILE_SIZE = 10_000; // 10KB
    if (file.size < MIN_FILE_SIZE) {
      throw new AppError("FILE_TOO_SMALL", "Audio file is too small. Please upload a clip of at least 3 seconds.", 400);
    }

    // Basic magic bytes validation for common audio formats
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const header = buffer.subarray(0, 12);

    const isRiff = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46; // RIFF (WAV)
    const isId3 = header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33; // ID3 (MP3)
    const isMp3Sync = (header[0] === 0xFF && ((header[1] ?? 0) & 0xE0) === 0xE0); // MP3 sync word
    const isFtyp = header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70; // ftyp (M4A/MP4)
    const isOgg = header[0] === 0x4F && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53; // OggS
    const isFlac = header[0] === 0x66 && header[1] === 0x4C && header[2] === 0x61 && header[3] === 0x43; // fLaC
    const isAac = header[0] === 0xFF && (header[1] === 0xF1 || header[1] === 0xF9); // ADTS AAC
    const isAiff = header[0] === 0x46 && header[1] === 0x4F && header[2] === 0x52 && header[3] === 0x4D; // FORM (AIFF)
    const isAmr = header[0] === 0x23 && header[1] === 0x21 && header[2] === 0x41; // #!AMR

    if (!isRiff && !isId3 && !isMp3Sync && !isFtyp && !isOgg && !isFlac && !isAac && !isAiff && !isAmr) {
      throw new AppError("INVALID_AUDIO", "File does not appear to be a valid audio file. Please upload a real audio recording.", 400);
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    const hasValidType = ALLOWED_TYPES.includes(file.type);
    const hasValidExt = VALID_EXTENSIONS.includes(ext || "");

    if (!hasValidType && !hasValidExt) {
      throw new AppError("INVALID_TYPE", "Unsupported audio format. Use MP3, WAV, M4A, FLAC, OGG, AAC, WMA, OPUS, AIFF, etc.", 400);
    }

    if (hasValidExt && !hasValidType && file.type && !file.type.startsWith("audio/")) {
      throw new AppError("INVALID_TYPE", "File MIME type does not match audio format.", 400);
    }

    const fileId = randomUUID();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${sanitizedName}`;

    const result = await uploadFile(`voices/${fileId}`, filename, buffer, file.type);

    return NextResponse.json({
      storagePath: result.path,
      fileName: file.name,
      fileSize: file.size,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
