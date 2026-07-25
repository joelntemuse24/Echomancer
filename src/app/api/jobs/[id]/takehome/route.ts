import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { execute, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { estimatePriceEur, streamMaxChars } from "@/lib/tts/pricing";
import { scheduleTakehomeContinue } from "@/lib/tts/process-job";
import { handleApiError } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * Spawn a take-home job from an existing stream session (same book + voice).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await params;

    const parent = await queryOne<{
      id: string;
      pdf_storage_path: string;
      book_title: string;
      voice_name: string | null;
      tts_provider: string | null;
      provider_voice_id: string | null;
      catalog_voice_id: string | null;
      tts_options: string | null;
      char_count: number | null;
    }>(
      `SELECT id, pdf_storage_path, book_title, voice_name, tts_provider,
              provider_voice_id, catalog_voice_id, tts_options, char_count
       FROM jobs WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );

    if (!parent) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const catalog = parent.catalog_voice_id
      ? await getCatalogVoice(parent.catalog_voice_id)
      : undefined;
    const charCount = parent.char_count || 0;
    const price =
      catalog && charCount > 0
        ? estimatePriceEur({ charCount, voice: catalog })
        : null;

    const jobId = randomUUID();

    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, voice_name, status, progress,
         pdf_storage_path, voice_storage_path, start_time, end_time,
         generation_mode, job_kind, tts_provider, provider_voice_id,
         catalog_voice_id, tts_options, char_count, parent_job_id,
         price_estimate_eur, stream_max_chars, next_section_index
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        "anonymous",
        parent.book_title,
        parent.voice_name,
        "queued",
        0,
        parent.pdf_storage_path,
        null,
        0,
        0,
        "stock",
        "takehome",
        parent.tts_provider,
        parent.provider_voice_id,
        parent.catalog_voice_id,
        parent.tts_options,
        charCount,
        parent.id,
        price?.suggestedPriceEur ?? null,
        streamMaxChars(),
        0,
      ]
    );

    scheduleTakehomeContinue(jobId);

    return NextResponse.json({
      jobId,
      status: "queued",
      parentJobId: parent.id,
      priceEstimate: price,
      message: "Take-home audiobook job created",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
