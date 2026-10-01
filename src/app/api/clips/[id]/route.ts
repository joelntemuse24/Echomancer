/**
 * Status for one proxied clip. A finished row includes a 10-minute signed URL.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import { isDurableUserId } from "@/lib/auth/session";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { signedDownloadUrl } from "@/lib/storage";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import { queryOne } from "@/lib/turso";
import { getYoutubeClipForUser } from "@/lib/youtube/clip-store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);
    const { id } = await context.params;
    if (!isDurableUserId(session.userId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const row = await getYoutubeClipForUser(session.userId, id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let downloadUrl: string | null = null;
    if (row.status === "ready" && row.r2_key) {
      downloadUrl = await signedDownloadUrl(row.r2_key).catch(() => null);
    }
    const voice = await queryOne<{ id: string }>(
      `SELECT id FROM cloned_voices WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, session.userId]
    );
    return NextResponse.json({
      id: row.id,
      status: row.status,
      error: row.error_code,
      downloadUrl,
      catalogVoiceId: voice ? catalogIdForClone(voice.id) : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
