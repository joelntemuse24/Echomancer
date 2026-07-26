import { NextRequest, NextResponse } from "next/server";
import { createJobSchema, paginationSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { createRateLimiter } from "@/lib/rate-limit";
import { execute, query, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { getCatalogVoice, getDefaultCatalogVoice } from "@/lib/tts/catalog";
import { estimatePriceEur, streamMaxChars } from "@/lib/tts/pricing";
import {
  chainTakehomeContinue,
  nudgeStaleTakehomeJobs,
} from "@/lib/tts/process-job";
import { downloadFile } from "@/lib/storage";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";

export const runtime = "nodejs";
export const maxDuration = 300;

const checkRateLimit = createRateLimiter(5, 60_000);

async function resolveCharCount(
  pdfStoragePath: string,
  provided?: number
): Promise<number> {
  if (provided && provided > 0) return provided;
  try {
    const buf = await downloadFile(pdfStoragePath);
    return buf.toString("utf-8").length;
  } catch {
    return 0;
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!(await checkRateLimit(ip))) {
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

    // ─── Stock (stream | takehome) ───
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
      parsed.voiceName ||
      catalog?.displayName ||
      providerVoiceId;

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

    // H5: Enforce premium HD gate at job creation
    if (
      isHdVoice({
        model: `${resolvedModel} ${providerVoiceId}`,
        tags: catalog?.tags,
      })
    ) {
      const hdEnabled = isPremiumHdEnabled({ ip });
      if (!hdEnabled) {
        return NextResponse.json(
          { error: "HD voices are a premium feature. Use a standard narrator." },
          { status: 403 }
        );
      }
    }

    const charCount = await resolveCharCount(
      parsed.pdfStoragePath,
      parsed.charCount
    );
    const price = estimatePriceEur({
      charCount,
      voice: voiceForPrice,
    });

    const jobKind = parsed.jobKind;
    const jobId = randomUUID();
    // Persist OpenRouter model slug for synthesis
    const ttsOptions = JSON.stringify({
      ...(parsed.ttsOptions || {}),
      model: resolvedModel,
    });

    // Dedup takehome only
    if (jobKind === "takehome") {
      const existing = await query<{ id: string; status: string }>(
        `SELECT id, status FROM jobs
         WHERE pdf_storage_path = ? AND tts_provider = ? AND provider_voice_id = ?
         AND job_kind = 'takehome' AND status = 'ready' AND deleted_at IS NULL
         LIMIT 1`,
        [parsed.pdfStoragePath, ttsProvider, providerVoiceId]
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
        "anonymous",
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

    if (jobKind === "takehome") {
      chainTakehomeContinue(jobId);
    }
    // stream jobs start audio on GET /api/jobs/[id]/stream

    return NextResponse.json({
      jobId,
      status: "queued",
      mode: "stock",
      jobKind,
      priceEstimate: price,
      message:
        jobKind === "stream"
          ? "Stream session ready — open /api/jobs/{id}/stream to listen"
          : "Take-home job created and generation started",
      streamUrl:
        jobKind === "stream" ? `/api/jobs/${jobId}/stream` : undefined,
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

    const offset = (page - 1) * limit;

    const countResult = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM jobs WHERE deleted_at IS NULL`
    );
    const count = countResult?.count ?? 0;

    const jobs = await query<Record<string, unknown>>(
      `SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    // Library polls every 3s while jobs are active — use that to re-kick
    // take-homes left queued after a processing wave ends (no HTTP self-loop).
    const hasStaleQueued = jobs.some(
      (j) =>
        j.job_kind === "takehome" &&
        j.status === "queued" &&
        typeof j.updated_at === "number" &&
        Date.now() / 1000 - (j.updated_at as number) >= 20
    );
    if (hasStaleQueued) {
      void nudgeStaleTakehomeJobs(2);
    }

    const formattedJobs = jobs.map((job) => formatJobRow(job));

    return NextResponse.json({
      jobs: formattedJobs,
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

function formatJobRow(job: Record<string, unknown>) {
  let segments = null;
  if (typeof job.segments_json === "string" && job.segments_json) {
    try {
      segments = JSON.parse(job.segments_json);
    } catch {
      segments = null;
    }
  }

  const createdAt = job.created_at as number;
  const updatedAt = job.updated_at as number;

  return {
    id: job.id,
    book_title: job.book_title,
    voice_name: job.voice_name,
    status: job.status,
    progress: job.progress,
    current_section: job.current_section,
    total_sections: job.total_sections,
    duration_seconds: job.duration_seconds,
    error_message: job.error_message,
    generation_mode: job.generation_mode ?? "stock",
    job_kind: job.job_kind ?? "takehome",
    tts_provider: job.tts_provider ?? null,
    provider_voice_id: job.provider_voice_id ?? null,
    catalog_voice_id: job.catalog_voice_id ?? null,
    char_count: job.char_count ?? 0,
    stream_cursor: job.stream_cursor ?? 0,
    stream_chars_used: job.stream_chars_used ?? 0,
    stream_max_chars: job.stream_max_chars ?? null,
    segments,
    price_estimate_eur: job.price_estimate_eur ?? null,
    parent_job_id: job.parent_job_id ?? null,
    audio_url: job.audio_storage_path
      ? `/api/storage/${job.audio_storage_path}`
      : undefined,
    stream_url:
      job.job_kind === "stream" ? `/api/jobs/${job.id}/stream` : undefined,
    created_at: new Date((createdAt || 0) * 1000).toISOString(),
    updated_at: new Date((updatedAt || 0) * 1000).toISOString(),
  };
}
