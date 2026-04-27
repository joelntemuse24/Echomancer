import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AppError, handleApiError } from "@/lib/errors";
import { z } from "zod";

const saveVoiceSchema = z.object({
  name: z.string().min(1).max(200),
  storagePath: z.string().min(1),
  source: z.enum(["youtube", "upload"]),
  sourceVideoId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = saveVoiceSchema.parse(body);

    const insertStmt = db.prepare(`
      INSERT INTO voices (user_id, name, storage_path, source, source_video_id)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      "anonymous",
      parsed.name,
      parsed.storagePath,
      parsed.source,
      parsed.sourceVideoId || null
    );

    // Get the inserted voice
    const voiceStmt = db.prepare(`SELECT * FROM voices WHERE rowid = ?`);
    const voice = voiceStmt.get(result.lastInsertRowid) as {
      id: string;
      user_id: string;
      name: string;
      storage_path: string;
      source: string;
      source_video_id: string | null;
      voice_id: string | null;
      created_at: number;
    };

    // Format to match old Supabase format
    const formattedVoice = {
      id: voice.id,
      user_id: voice.user_id,
      name: voice.name,
      storage_path: voice.storage_path,
      source: voice.source,
      source_video_id: voice.source_video_id,
      voice_id: voice.voice_id,
      created_at: new Date(voice.created_at * 1000).toISOString(),
    };

    return NextResponse.json({ voice: formattedVoice });
  } catch (error) {
    console.error("[Voices API] Error:", error);
    return handleApiError(error);
  }
}

export async function GET() {
  try {
    const stmt = db.prepare(`
      SELECT * FROM voices
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const voices = stmt.all("anonymous") as Array<{
      id: string;
      user_id: string;
      name: string;
      storage_path: string;
      source: string;
      source_video_id: string | null;
      voice_id: string | null;
      created_at: number;
    }>;

    // Format to match old Supabase format
    const formattedVoices = voices.map((voice) => ({
      id: voice.id,
      user_id: voice.user_id,
      name: voice.name,
      storage_path: voice.storage_path,
      source: voice.source,
      source_video_id: voice.source_video_id,
      voice_id: voice.voice_id,
      created_at: new Date(voice.created_at * 1000).toISOString(),
    }));

    return NextResponse.json({ voices: formattedVoices });
  } catch (error) {
    console.error("[Voices API] GET Error:", error);
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      throw new AppError("MISSING_ID", "Voice ID is required", 400);
    }

    const stmt = db.prepare(`DELETE FROM voices WHERE id = ?`);
    stmt.run(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Voices API] DELETE Error:", error);
    return handleApiError(error);
  }
}
