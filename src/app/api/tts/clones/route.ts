import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { handleApiError, AppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import {
  createFishVoiceClone,
  FISH_NATIVE_FREE_MODEL,
  isFishConfigured,
} from "@/lib/tts/providers/fish";
import {
  insertClonedVoice,
  listClonedVoicesForUser,
} from "@/lib/turso/cloned-voices";
import {
  catalogIdForClone,
  clonedVoiceToCatalog,
} from "@/lib/tts/fish-clone";
import { uploadFile } from "@/lib/storage";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { cleanupCloneSample } from "@/lib/tts/clone-sample-audio";
import { VERCEL_FUNCTION_BODY_LIMIT_BYTES } from "@/lib/document-formats";

export const runtime = "nodejs";
export const maxDuration = 60;

const cloneRateLimit = createRateLimiter(5, 60 * 60_000, { onError: "closed" });

const MAX_SAMPLE_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_SAMPLE_BYTES = 8 * 1024; // ~8 KB — reject empty/tiny uploads
const ALLOWED_EXT = new Set(["wav", "mp3", "m4a", "opus", "ogg", "webm"]);

function extensionOf(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1]! : "";
}

export async function GET(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);
    if (!isFishConfigured()) {
      return NextResponse.json({
        clones: [],
        configured: false,
        error: "Set FISH_API_KEY to enable voice cloning.",
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

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);

    if (!isFishConfigured()) {
      throw new AppError(
        "FISH_NOT_CONFIGURED",
        "Voice cloning needs FISH_API_KEY on the server.",
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

    const existing = await listClonedVoicesForUser(session.userId);
    if (existing.length >= 20) {
      throw new AppError(
        "CLONE_LIMIT",
        "You already have 20 cloned voices. Delete one to add another.",
        400
      );
    }

    const declaredLength = Number(request.headers.get("content-length") || "0");
    if (declaredLength > VERCEL_FUNCTION_BODY_LIMIT_BYTES) {
      throw new AppError(
        "FILE_TOO_LARGE",
        "That sample is too large for the app server. Use a clip under about 4 MB (a shorter recording), or trim it first.",
        413
      );
    }

    const form = await request.formData();
    const titleRaw = String(form.get("title") || "").trim();
    const title = titleRaw || "My voice";
    const transcript = String(form.get("transcript") || "").trim() || undefined;
    const file = form.get("audio");

    if (!(file instanceof File)) {
      throw new AppError(
        "INVALID_SAMPLE",
        "Upload a short audio sample (wav, mp3, m4a, or opus).",
        400
      );
    }

    const ext = extensionOf(file.name || "sample.wav");
    if (!ALLOWED_EXT.has(ext)) {
      throw new AppError(
        "INVALID_SAMPLE",
        "Use wav, mp3, m4a, opus, ogg, or webm samples.",
        400
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength < MIN_SAMPLE_BYTES) {
      throw new AppError(
        "INVALID_SAMPLE",
        "That sample is too short. Use at least ~10 seconds of clear speech.",
        400
      );
    }
    if (buf.byteLength > VERCEL_FUNCTION_BODY_LIMIT_BYTES) {
      throw new AppError(
        "FILE_TOO_LARGE",
        "That sample is too large for the app server. Use a clip under about 4 MB (a shorter recording), or trim it first.",
        413
      );
    }
    if (buf.byteLength > MAX_SAMPLE_BYTES) {
      throw new AppError(
        "INVALID_SAMPLE",
        "Sample must be 10 MB or smaller.",
        400
      );
    }

    const prepared = cleanupCloneSample(
      buf,
      `sample.${ext}`,
      file.type || undefined
    );

    // Clone on Fish first so a failed upstream call does not leave a DB row.
    const fish = await createFishVoiceClone({
      title: title.slice(0, 80),
      audio: prepared.audio,
      filename: prepared.filename,
      contentType: prepared.contentType,
      transcript,
      description: "Echomancer cloned narrator",
    });

    const cloneId = randomUUID();
    const samplePath = `clones/${cloneId}/${prepared.filename}`;
    await uploadFile(
      `clones/${cloneId}`,
      prepared.filename,
      prepared.audio,
      prepared.contentType
    );

    const row = await insertClonedVoice({
      id: cloneId,
      userId: session.userId,
      fishVoiceId: fish.fishVoiceId,
      title: fish.title.slice(0, 80),
      sampleStoragePath: samplePath,
      state: fish.state,
      model: FISH_NATIVE_FREE_MODEL,
    });

    const catalog = clonedVoiceToCatalog(row);

    return NextResponse.json({
      clone: {
        ...catalog,
        catalogVoiceId: catalog.id,
        state: row.state,
        createdAt: row.created_at,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
