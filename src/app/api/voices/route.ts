import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { z } from "zod";
import { execute, query, queryOne } from "@/lib/turso";
import { deleteFile } from "@/lib/storage";
import { ensureVoiceStyleColumns } from "@/lib/turso/schema";
import { voiceClipsSchema } from "@/lib/voice-clips";

const saveVoiceSchema = z.object({
  name: z.string().min(1).max(200),
  storagePath: z.string().min(1),
  source: z.enum(["youtube", "upload"]),
  voiceClips: voiceClipsSchema.optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = saveVoiceSchema.parse(body);
    await ensureVoiceStyleColumns();

    const result = await execute(
      `INSERT INTO voices (user_id, name, storage_path, source, source_video_id, voice_clips)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "anonymous",
        parsed.name,
        parsed.storagePath,
        parsed.source,
        null,
        parsed.voiceClips ? JSON.stringify(parsed.voiceClips) : null,
      ]
    );

    const voice = await queryOne<{
      id: string; user_id: string; name: string; storage_path: string;
      source: string; source_video_id: string | null; voice_id: string | null;
      voice_clips: string | null; created_at: number;
    }>(
      `SELECT * FROM voices WHERE rowid = ?`,
      [Number(result.lastInsertRowid)]
    );

    if (!voice) {
      throw new AppError("NOT_FOUND", "Voice not found after insert", 500);
    }

    return NextResponse.json({
      voice: {
        id: voice.id,
        user_id: voice.user_id,
        name: voice.name,
        storage_path: voice.storage_path,
        source: voice.source,
        source_video_id: voice.source_video_id,
        voice_id: voice.voice_id,
        voice_clips: voice.voice_clips ? JSON.parse(voice.voice_clips) : null,
        created_at: new Date(voice.created_at * 1000).toISOString(),
      },
    });
  } catch (error) {
    console.error("[Voices API] Error:", error);
    return handleApiError(error);
  }
}

export async function GET() {
  try {
    await ensureVoiceStyleColumns();
    const voices = await query<{
      id: string; user_id: string; name: string; storage_path: string;
      source: string; source_video_id: string | null; voice_id: string | null;
      voice_clips: string | null; created_at: number;
    }>(
      `SELECT * FROM voices WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      ["anonymous"]
    );

    const formattedVoices = voices.map((voice) => ({
      id: voice.id,
      user_id: voice.user_id,
      name: voice.name,
      storage_path: voice.storage_path,
      source: voice.source,
      source_video_id: voice.source_video_id,
      voice_id: voice.voice_id,
      voice_clips: voice.voice_clips ? JSON.parse(voice.voice_clips) : null,
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

    const voice = await queryOne<{ storage_path: string }>("SELECT storage_path FROM voices WHERE id = ?", [id]);
    if (voice?.storage_path) {
      await deleteFile(voice.storage_path).catch(() => {});
    }

    await execute(`DELETE FROM voices WHERE id = ?`, [id]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Voices API] DELETE Error:", error);
    return handleApiError(error);
  }
}
