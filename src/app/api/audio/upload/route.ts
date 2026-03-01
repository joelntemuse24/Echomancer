import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";

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
];

const VALID_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "webm", "mp4"];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      throw new AppError("MISSING_FILE", "No file provided", 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new AppError("FILE_TOO_LARGE", "File too large. Maximum size is 50MB.", 400);
    }

    if (file.size === 0) {
      throw new AppError("EMPTY_FILE", "File is empty", 400);
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!ALLOWED_TYPES.includes(file.type) && !VALID_EXTENSIONS.includes(ext || "")) {
      throw new AppError("INVALID_TYPE", "Unsupported audio format. Use MP3, WAV, M4A, or OGG.", 400);
    }

    const supabase = createServerClient();
    const fileId = randomUUID();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `voices/${fileId}/${sanitizedName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from("audiobooks")
      .upload(storagePath, buffer, {
        contentType: file.type || "audio/mpeg",
        upsert: false,
      });

    if (uploadError) {
      throw new AppError("UPLOAD_FAILED", `Failed to upload file: ${uploadError.message}`, 500);
    }

    return NextResponse.json({
      storagePath,
      fileName: file.name,
      fileSize: file.size,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
