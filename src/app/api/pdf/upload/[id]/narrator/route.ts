/**
 * GET /api/pdf/upload/[id]/narrator — one DeepSeek suggestion for this upload.
 *
 * Cleans the whole book, then asks DeepSeek. A saved narrator.json is
 * returned on later visits. Clones are not part of the suggestion. The
 * voice picker may ignore it.
 */

import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { SessionSecretMissingError } from "@/lib/auth/session";
import { requireSession } from "@/lib/auth/guard";
import { getUploadByIdForUser, uploadStatus } from "@/lib/turso/uploads";
import { loadNarratorRecommendation } from "@/lib/tts/narrator-recommendation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const session = await requireSession(request);
    const row = await getUploadByIdForUser(session.userId, id);
    if (!row) {
      throw new AppError("NOT_FOUND", "Upload not found", 404);
    }
    if (uploadStatus(row) !== "ready") {
      return NextResponse.json({ narrator: null });
    }
    const narrator = await loadNarratorRecommendation(id, row.file_name);
    return NextResponse.json({ narrator });
  } catch (error) {
    if (error instanceof SessionSecretMissingError) {
      return NextResponse.json(
        { error: "This deployment is missing its session secret." },
        { status: 503 }
      );
    }
    return handleApiError(error);
  }
}
