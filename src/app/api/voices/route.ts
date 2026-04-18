import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
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

    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("voices")
      .insert({
        user_id: "anonymous",
        name: parsed.name,
        storage_path: parsed.storagePath,
        source: parsed.source,
        source_video_id: parsed.sourceVideoId || null,
      })
      .select()
      .single();

    if (error) {
      throw new AppError("DB_INSERT_FAILED", `Failed to save voice: ${error.message}`, 500);
    }

    return NextResponse.json({ voice: data });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET() {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("voices")
      .select("*")
      .eq("user_id", "anonymous")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      throw new AppError("DB_QUERY_FAILED", error.message, 500);
    }

    return NextResponse.json({ voices: data || [] });
  } catch (error) {
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

    const supabase = createServerClient();
    const { error } = await supabase.from("voices").delete().eq("id", id);

    if (error) {
      throw new AppError("DB_DELETE_FAILED", error.message, 500);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
