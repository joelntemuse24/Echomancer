import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, AppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { isFishConfigured } from "@/lib/tts/providers/fish";
import {
  getClonedVoiceForUser,
  listClonedVoicesForUser,
} from "@/lib/turso/cloned-voices";
import {
  cloneUploadStatus,
  getCloneUploadByIdForUser,
  markCloneUploadCompleted,
} from "@/lib/turso/clone-uploads";
import {
  catalogIdForClone,
  clonedVoiceToCatalog,
  type ClonedVoiceRow,
} from "@/lib/tts/fish-clone";
import {
  CLONE_ACCENTS,
  DEFAULT_CLONE_ACCENT,
  parseCloneAccent,
} from "@/lib/tts/clone-accent";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { completeStoredClone } from "@/lib/tts/complete-clone";
import {
  rejectMultipartUpload,
  rejectOversizedFunctionBody,
} from "@/lib/uploads/http";
import {
  canonicalYoutubeUrl,
  isYoutubeVideoId,
  validateClipRange,
} from "@/lib/youtube/range";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";

export const runtime = "nodejs";
export const maxDuration = 60;

const cloneRateLimit = createRateLimiter(5, 60 * 60_000, { onError: "closed" });

const CLONE_CREATE_MULTIPART =
  "Do not POST the audio sample through this server. Request a storage URL with JSON { fileName, contentType, byteSize }, PUT the file there, then create the clone with { uploadId }.";

const createSchema = z.object({
  uploadId: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).optional(),
  transcript: z.string().trim().max(4000).optional(),
  accent: z.enum(CLONE_ACCENTS).optional(),
  acceptQualityRisk: z.boolean().optional(),
  youtube: z
    .object({
      videoId: z.string().trim(),
      startSec: z.number(),
      endSec: z.number(),
      consent: z.literal(true),
    })
    .optional(),
});

export async function GET(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);
    if (!isFishConfigured()) {
      return NextResponse.json({
        clones: [],
        configured: false,
        error: "Cloning isn't available right now.",
      });
    }
    const rows = await listClonedVoicesForUser(session.userId);
    return NextResponse.json({
      configured: true,
      clones: rows.map((r) => ({
        ...clonedVoiceToCatalog(r),
        catalogVoiceId: catalogIdForClone(r.id),
        state: r.state,
        createdAt: r.created_at,
      })),
      count: rows.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function cloneResponse(row: ClonedVoiceRow) {
  const catalog = clonedVoiceToCatalog(row);
  return {
    clone: {
      ...catalog,
      catalogVoiceId: catalog.id,
      state: row.state,
      createdAt: row.created_at,
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    rejectMultipartUpload(request, CLONE_CREATE_MULTIPART);
    rejectOversizedFunctionBody(request);

    const session = await requireSession(request);

    if (!isFishConfigured()) {
      throw new AppError(
        "FISH_NOT_CONFIGURED",
        "Cloning isn't available right now.",
        503
      );
    }

    const identity = await rateLimitIdentity({
      userId: session.userId,
      ip: clientIp(request),
    });
    if (!(await cloneRateLimit(identity))) {
      return NextResponse.json(
        { error: "Too many clone attempts. Try again later." },
        { status: 429 }
      );
    }

    const raw = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        "INVALID_BODY",
        "Send JSON { uploadId, title?, accent? } after PUTting the sample to storage. accent is american, british, australian, or irish.",
        400
      );
    }

    const { uploadId } = parsed.data;
    const title = parsed.data.title?.trim() || "My voice";
    const transcript = parsed.data.transcript?.trim() || undefined;
    const accent = parseCloneAccent(parsed.data.accent ?? DEFAULT_CLONE_ACCENT);
    let source: {
      kind: "youtube";
      url: string;
      startSec: number;
      endSec: number;
      consentedAt: number;
    } | null = null;
    if (parsed.data.youtube) {
      if (!isYoutubeVideoId(parsed.data.youtube.videoId)) {
        throw new AppError("INVALID_BODY", "That link is not a YouTube video.", 400);
      }
      const range = validateClipRange(
        parsed.data.youtube.startSec,
        parsed.data.youtube.endSec
      );
      if (!range.ok) {
        throw new AppError("INVALID_RANGE", range.message || YOUTUBE_COPY.rangeInvalid, 400);
      }
      source = {
        kind: "youtube",
        url: canonicalYoutubeUrl(parsed.data.youtube.videoId),
        startSec: range.startSec,
        endSec: range.endSec,
        consentedAt: Math.floor(Date.now() / 1000),
      };
    }

    const upload = await getCloneUploadByIdForUser(session.userId, uploadId);
    if (!upload) {
      throw new AppError("NOT_FOUND", "Cloned voice not found", 404);
    }

    const already = await getClonedVoiceForUser(session.userId, uploadId);
    if (already) {
      if (cloneUploadStatus(upload) !== "completed") {
        await markCloneUploadCompleted(uploadId, already.id);
      }
      return NextResponse.json(cloneResponse(already));
    }

    const status = cloneUploadStatus(upload);
    if (status === "completed" && upload.cloned_voice_id) {
      const existing = await getClonedVoiceForUser(
        session.userId,
        upload.cloned_voice_id
      );
      if (existing) return NextResponse.json(cloneResponse(existing));
    }

    const existing = await listClonedVoicesForUser(session.userId);
    if (existing.length >= 20) {
      throw new AppError(
        "CLONE_LIMIT",
        "You already have 20 cloned voices. Delete one to add another.",
        400
      );
    }

    const row = await completeStoredClone({
      userId: session.userId,
      upload,
      title,
      transcript,
      accent,
      source,
      acceptQualityRisk: parsed.data.acceptQualityRisk === true,
    });
    return NextResponse.json(cloneResponse(row));
  } catch (error) {
    return handleApiError(error);
  }
}
