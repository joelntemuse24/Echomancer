/**
 * Listening position for a book the caller owns.
 * Another session's book is 404. The body is a book-clock timestamp.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handleApiError } from "@/lib/errors";
import { requireOwnedJob } from "@/lib/auth/guard";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  getPlaybackPosition,
  upsertPlaybackPosition,
} from "@/lib/turso/playback-positions";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

const putSchema = z.object({
  positionSeconds: z.number().finite().min(0).max(1_000_000),
  sectionIndex: z.number().int().min(0).max(100_000).nullable().optional(),
  expectedUpdatedAt: z.number().int().min(0).nullable().optional(),
  force: z.boolean().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await params;
    const { session } = await requireOwnedJob(request, id, "id, user_id");
    const position = await getPlaybackPosition(session.userId, id);
    return NextResponse.json(
      {
        positionSeconds: position?.positionSeconds ?? null,
        sectionIndex: position?.sectionIndex ?? null,
        updatedAt: position?.updatedAt ?? null,
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await params;
    const { session } = await requireOwnedJob(request, id, "id, user_id");
    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("INVALID_BODY", "That position could not be saved.", 400);
    }
    const write = await upsertPlaybackPosition({
      userId: session.userId,
      jobId: id,
      positionSeconds: parsed.data.positionSeconds,
      sectionIndex: parsed.data.sectionIndex ?? null,
      expectedUpdatedAt: parsed.data.expectedUpdatedAt ?? null,
      force: parsed.data.force === true,
    });
    return NextResponse.json(
      {
        positionSeconds: write.position.positionSeconds,
        sectionIndex: write.position.sectionIndex,
        updatedAt: write.position.updatedAt,
        stale: !write.accepted,
      },
      { status: write.accepted ? 200 : 409, headers: NO_STORE }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
