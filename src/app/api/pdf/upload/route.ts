import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      throw new AppError("MISSING_FILE", "No file provided", 400);
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      throw new AppError("INVALID_TYPE", "Only PDF files are supported", 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new AppError("FILE_TOO_LARGE", "File too large. Maximum size is 100MB.", 400);
    }

    if (file.size === 0) {
      throw new AppError("EMPTY_FILE", "File is empty", 400);
    }

    const supabase = createServerClient();
    const fileId = randomUUID();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `pdfs/${fileId}/${sanitizedName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from("audiobooks")
      .upload(storagePath, buffer, {
        contentType: "application/pdf",
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
