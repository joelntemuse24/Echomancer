/**
 * Playhead marks for a book the caller owns.
 * Another session's book is 404. A mark within 2s on the same clock is the
 * existing row, so a double tap does not stack.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handleApiError } from "@/lib/errors";
import { requireOwnedJob } from "@/lib/auth/guard";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { cleanBookmarkLabel } from "@/lib/player/bookmarks";
import {
  findNearBookmark,
  insertBookmark,
  listBookmarks,
} from "@/lib/turso/bookmarks";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

const createSchema = z.object({
  positionSeconds: z.number().finite().min(0).max(1_000_000),
  sectionIndex: z.number().int().min(0).max(100_000).nullable().optional(),
  label: z.string().max(2_000).nullable().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await params;
    const { session } = await requireOwnedJob(
      request,
      id,
      "id, user_id, status, job_kind, pdf_storage_path"
    );
    const bookmarks = await listBookmarks(session.userId, id);
    return NextResponse.json({ bookmarks }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await params;
    const { session } = await requireOwnedJob(
      request,
      id,
      "id, user_id, status, job_kind, pdf_storage_path"
    );
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("INVALID_BODY", "That bookmark could not be saved.", 400);
    }
    const sectionIndex = parsed.data.sectionIndex ?? null;
    const label = cleanBookmarkLabel(parsed.data.label);
    const existing = await findNearBookmark(
      session.userId,
      id,
      parsed.data.positionSeconds,
      sectionIndex
    );
    if (existing) {
      return NextResponse.json(
        { bookmark: existing, duplicate: true },
        { headers: NO_STORE }
      );
    }
    const bookmark = await insertBookmark({
      userId: session.userId,
      jobId: id,
      positionSeconds: parsed.data.positionSeconds,
      sectionIndex,
      label,
    });
    return NextResponse.json(
      { bookmark, duplicate: false },
      { status: 201, headers: NO_STORE }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
