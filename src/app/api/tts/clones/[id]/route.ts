import { NextRequest, NextResponse } from "next/server";
import { handleApiError, AppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import {
  getClonedVoiceForUser,
  softDeleteClonedVoice,
} from "@/lib/turso/cloned-voices";
import {
  catalogIdForClone,
  clonedVoiceToCatalog,
  cloneRowIdFromCatalogId,
} from "@/lib/tts/fish-clone";

export const runtime = "nodejs";

function resolveCloneId(raw: string): string {
  return cloneRowIdFromCatalogId(raw) || raw;
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
    const catalog = clonedVoiceToCatalog(row);
    return NextResponse.json({
      clone: {
        ...catalog,
        catalogVoiceId: catalogIdForClone(row.id),
        state: row.state,
        createdAt: row.created_at,
      },
    });
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
