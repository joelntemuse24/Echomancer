import { NextRequest, NextResponse } from "next/server";
import { createJobSchema, paginationSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { execute, query, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { getCatalogVoice, getDefaultCatalogVoice } from "@/lib/tts/catalog";
import { estimatePriceEur, streamMaxChars } from "@/lib/tts/pricing";
import { nudgeStaleTakehomeJobs } from "@/lib/tts/process-job";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";
import { isTakehomeFriendly } from "@/lib/tts/voice-persona";
import {
  isAllowedCatalogVoice,
  isAllowedSpeechModel,
} from "@/lib/tts/catalog/allowlist";
import { serializeJob } from "@/lib/jobs/serialize";
import { readSession } from "@/lib/auth/session";
import { requireSession } from "@/lib/auth/guard";
import { getUploadForUser } from "@/lib/turso/uploads";

export const runtime = "nodejs";
export const maxDuration = 60;

// Creating a job commits us to upstream spend, so a broken counter must not
// become an unlimited allowance.
const checkRateLimit = createRateLimiter(5, 60_000, { onError: "closed" });

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();

    const session = await requireSession(request);
    const identity = await rateLimitIdentity({
      userId: session.userId,
      ip: clientIp(request),
    });
    if (!(await checkRateLimit(identity))) {
      return NextResponse.json(
        {
          error:
            "Too many requests. Please wait a minute before creating another job.",
        },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = createJobSchema.parse(body);

    // The browser supplies `pdfStoragePath`, so it is only trustworthy after we
    // confirm this session is the one that uploaded it.
    const upload = await getUploadForUser(
      session.userId,
      parsed.pdfStoragePath
    );
    if (!upload) {
      throw new AppError(
        "UPLOAD_NOT_FOUND",
        "We couldn't find that upload. Please upload your book again.",
        404
      );
    }

    const catalog = parsed.catalogVoiceId
      ? await getCatalogVoice(parsed.catalogVoiceId, { hdEnabled: true })
      : parsed.ttsProvider && parsed.providerVoiceId
        ? undefined
        : getDefaultCatalogVoice();

    const ttsProvider =
      parsed.ttsProvider || catalog?.provider || getDefaultCatalogVoice().provider;
    const providerVoiceId =
      parsed.providerVoiceId ||
      catalog?.providerVoiceId ||
      getDefaultCatalogVoice().providerVoiceId;
    const catalogVoiceId = parsed.catalogVoiceId || catalog?.id || null;
    const voiceName =
      parsed.voiceName || catalog?.displayName || providerVoiceId;

    if (!ttsProvider || !providerVoiceId) {
      throw new AppError(
        "INVALID_VOICE",
        "catalogVoiceId or ttsProvider+providerVoiceId required",
        400
      );
    }

    const voiceForPrice =
      catalog ||
      (catalogVoiceId
        ? await getCatalogVoice(catalogVoiceId, { hdEnabled: true })
        : undefined) ||
      getDefaultCatalogVoice();
    const resolvedModel =
      parsed.ttsOptions?.model || catalog?.model || voiceForPrice.model;

    if (
      !isAllowedSpeechModel(resolvedModel) &&
      !isAllowedCatalogVoice({
        model: resolvedModel,
        provider: catalog?.provider || ttsProvider,
      })
    ) {
      return NextResponse.json(
        {
          error:
            "That narrator isn't supported. Choose Gemini, Qwen, Microsoft, Grok, or Minimax HD.",
        },
        { status: 400 }
      );
    }

    if (
      isHdVoice({
        model: `${resolvedModel} ${providerVoiceId}`,
        tags: catalog?.tags,
      }) &&
      !isPremiumHdEnabled({
        ip: clientIp(request),
        userId: session.userId,
      })
    ) {
      return NextResponse.json(
        { error: "HD voices are a premium feature. Use a standard narrator." },
        { status: 403 }
      );
    }

    const charCount = parsed.charCount || upload.char_count || 0;
    const price = estimatePriceEur({ charCount, voice: voiceForPrice });

    const jobKind = parsed.jobKind;
    if (jobKind === "takehome" && catalog && !isTakehomeFriendly(catalog)) {
      return NextResponse.json(
        {
          error:
            "This narrator isn't suited for full audiobooks. Choose Gemini, Qwen, Microsoft, or Grok instead.",
        },
        { status: 400 }
      );
    }

    const jobId = randomUUID();
    const ttsOptions = JSON.stringify({
      ...(parsed.ttsOptions || {}),
      model: resolvedModel,
      ...(catalog?.stylePrompt ? { stylePrompt: catalog.stylePrompt } : {}),
      ...(catalog?.locale ? { locale: catalog.locale } : {}),
    });

    // Accent variants share a `providerVoiceId`, so dedupe on the catalog id or
    // British and American cards collide into one job.
    if (jobKind === "takehome") {
      const existing = await query<{ id: string; status: string }>(
        catalogVoiceId
          ? `SELECT id, status FROM jobs
             WHERE user_id = ? AND pdf_storage_path = ? AND catalog_voice_id = ?
             AND job_kind = 'takehome' AND status = 'ready' AND deleted_at IS NULL
             LIMIT 1`
          : `SELECT id, status FROM jobs
             WHERE user_id = ? AND pdf_storage_path = ? AND tts_provider = ?
             AND provider_voice_id = ?
             AND job_kind = 'takehome' AND status = 'ready' AND deleted_at IS NULL
             LIMIT 1`,
        catalogVoiceId
          ? [session.userId, parsed.pdfStoragePath, catalogVoiceId]
          : [
              session.userId,
              parsed.pdfStoragePath,
              ttsProvider,
              providerVoiceId,
            ]
      );
      if (existing.length > 0) {
        return NextResponse.json({
          jobId: existing[0]!.id,
          status: "ready",
          duplicate: true,
          message: "Take-home audiobook already exists",
          priceEstimate: price,
        });
      }
    }

    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, voice_name, status, progress,
         pdf_storage_path,
         generation_mode, job_kind, tts_provider, provider_voice_id,
         catalog_voice_id, tts_options, char_count, parent_job_id,
         price_estimate_eur, stream_max_chars, stream_cursor, stream_chars_used,
         next_section_index
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        session.userId,
        parsed.bookTitle,
        voiceName,
        "queued",
        0,
        parsed.pdfStoragePath,
        "stock",
        jobKind,
        ttsProvider,
        providerVoiceId,
        catalogVoiceId,
        ttsOptions,
        charCount,
        parsed.parentJobId ?? null,
        price.suggestedPriceEur,
        streamMaxChars(),
        0,
        0,
        0,
      ]
    );

    // Generation is *enqueued*, never run here: synthesizing inline made job
    // creation take tens of seconds and risked a gateway timeout on the one
    // request the user is actually waiting for. The worker picks it up.
    return NextResponse.json({
      jobId,
      status: "queued",
      progress: 0,
      mode: "stock",
      jobKind,
      priceEstimate: price,
      message:
        jobKind === "stream"
          ? "Stream session ready — open /api/jobs/{id}/stream to listen"
          : "Take-home job queued — generation starts shortly",
      streamUrl: jobKind === "stream" ? `/api/jobs/${jobId}/stream` : undefined,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    await ensureTtsJobColumns();

    const { searchParams } = new URL(request.url);
    const { page, limit } = paginationSchema.parse({
      page: searchParams.get("page") || "1",
      limit: searchParams.get("limit") || "20",
    });

    // A first-time visitor has no library yet; an empty list is a friendlier
    // (and equally safe) answer than 401.
    const session = await readSession(request);
    if (!session) {
      return NextResponse.json({
        jobs: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      });
    }

    const offset = (page - 1) * limit;

    const countResult = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM jobs WHERE user_id = ? AND deleted_at IS NULL`,
      [session.userId]
    );
    const count = countResult?.count ?? 0;

    const jobs = await query<Record<string, unknown>>(
      `SELECT * FROM jobs WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [session.userId, limit, offset]
    );

    // Cheap lease sweep so a crashed worker's job is queued again. This only
    // synthesizes when TTS_POLL_NUDGE_BUDGET_MS is non-zero (see process-job).
    if (jobs.some((j) => j.job_kind === "takehome" && j.status !== "ready")) {
      await nudgeStaleTakehomeJobs(2);
    }

    return NextResponse.json({
      jobs: jobs.map((job) => serializeJob(job)),
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
