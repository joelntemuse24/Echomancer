import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { NotFoundError, requireOwnedJob } from "@/lib/auth/guard";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { deleteBookmark } from "@/lib/turso/bookmarks";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; bookmarkId: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id, bookmarkId } = await params;
    const { session } = await requireOwnedJob(
      request,
      id,
      "id, user_id, status, job_kind, pdf_storage_path"
    );
    const removed = await deleteBookmark(session.userId, id, bookmarkId);
    if (!removed) throw new NotFoundError("Bookmark not found");
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
