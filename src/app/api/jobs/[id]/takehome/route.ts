import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { execute } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { estimatePriceEur, streamMaxChars } from "@/lib/tts/pricing";
import { handleApiError } from "@/lib/errors";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";
import { requireOwnedJob } from "@/lib/auth/guard";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import {
  assertCanDispatchTakehome,
  enqueueTakehomeAdvance,
} from "@/lib/jobs/trigger-takehome";

export const runtime = "nodejs";
export const maxDuration = 60;

const takehomeRateLimit = createRateLimiter(5, 60_000, { onError: "closed" });

/**
 * Promote a live listening session into a full audiobook job: same book, same
 * narrator, generated offline by the worker.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await params;
    const { session, job: parent } = await requireOwnedJob(request, id);

    const identity = await rateLimitIdentity({
      userId: session.userId,
      ip: clientIp(request),
    });
    if (!(await takehomeRateLimit(identity))) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute and try again." },
        { status: 429 }
      );
    }

    const catalogVoiceId =
      typeof parent.catalog_voice_id === "string"
        ? parent.catalog_voice_id
        : null;
    const catalog = catalogVoiceId
      ? await getCatalogVoice(catalogVoiceId, { hdEnabled: true })
      : undefined;

    const parentTtsOptions =
      typeof parent.tts_options === "string" ? parent.tts_options : null;
    let parentModel = catalog?.model || "";
    if (parentTtsOptions) {
      try {
        const options = JSON.parse(parentTtsOptions) as { model?: unknown };
        if (typeof options.model === "string") parentModel = options.model;
      } catch {
        /* keep the catalog model */
      }
    }

    const providerVoiceId =
      typeof parent.provider_voice_id === "string"
        ? parent.provider_voice_id
        : "";

    if (
      isHdVoice({
        model: `${parentModel} ${providerVoiceId}`,
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

    const charCount =
      typeof parent.char_count === "number" ? parent.char_count : 0;
    const price =
      catalog && charCount > 0
        ? estimatePriceEur({ charCount, voice: catalog })
        : null;

    const jobId = randomUUID();
    assertCanDispatchTakehome();

    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, voice_name, status, progress,
         pdf_storage_path,
         generation_mode, job_kind, tts_provider, provider_voice_id,
         catalog_voice_id, tts_options, char_count, parent_job_id,
         price_estimate_eur, stream_max_chars, next_section_index
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        session.userId,
        String(parent.book_title ?? "Untitled"),
        typeof parent.voice_name === "string" ? parent.voice_name : null,
        "queued",
        0,
        parent.pdf_storage_path,
        "stock",
        "takehome",
        typeof parent.tts_provider === "string" ? parent.tts_provider : null,
        providerVoiceId || null,
        catalogVoiceId,
        parentTtsOptions,
        charCount,
        parent.id,
        price?.suggestedPriceEur ?? null,
        streamMaxChars(),
        0,
      ]
    );

    await enqueueTakehomeAdvance(jobId);

    return NextResponse.json({
      jobId,
      status: "queued",
      parentJobId: parent.id,
      priceEstimate: price,
      message: "Take-home audiobook queued",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
