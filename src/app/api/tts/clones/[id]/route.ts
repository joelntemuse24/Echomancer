import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, AppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import {
  getClonedVoiceForUser,
  softDeleteClonedVoice,
  updateClonedVoiceAccent,
} from "@/lib/turso/cloned-voices";
import {
  catalogIdForClone,
  clonedVoiceToCatalog,
  cloneRowIdFromCatalogId,
} from "@/lib/tts/fish-clone";
import { CLONE_ACCENTS } from "@/lib/tts/clone-accent";

export const runtime = "nodejs";

function resolveCloneId(raw: string): string {
  return cloneRowIdFromCatalogId(raw) || raw;
}

const patchSchema = z.object({
  accent: z.enum(CLONE_ACCENTS),
});

function clonePayload(row: NonNullable<Awaited<ReturnType<typeof getClonedVoiceForUser>>>) {
  const catalog = clonedVoiceToCatalog(row);
  return {
    clone: {
      ...catalog,
      catalogVoiceId: catalogIdForClone(row.id),
      state: row.state,
      createdAt: row.created_at,
    },
  };
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession(request);
    const { id: raw } = await ctx.params;
    const id = resolveCloneId(raw);
    const row = await getClonedVoiceForUser(session.userId, id);
    if (!row) {
      throw new AppError("NOT_FOUND", "Cloned voice not found", 404);
    }
    return NextResponse.json(clonePayload(row));
  } catch (error) {
    return handleApiError(error);
  }
}

/** Relabel a clone the caller already owns. Does not retrain Fish. */
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession(request);
    const { id: raw } = await ctx.params;
    const id = resolveCloneId(raw);
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError(
        "INVALID_BODY",
        "Send JSON { accent } — american, british, australian, or irish.",
        400
      );
    }
    const row = await updateClonedVoiceAccent(
      session.userId,
      id,
      parsed.data.accent
    );
    if (!row) {
      throw new AppError("NOT_FOUND", "Cloned voice not found", 404);
    }
    return NextResponse.json(clonePayload(row));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession(request);
    const { id: raw } = await ctx.params;
    const id = resolveCloneId(raw);
    const ok = await softDeleteClonedVoice(session.userId, id);
    if (!ok) {
      throw new AppError("NOT_FOUND", "Cloned voice not found", 404);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
