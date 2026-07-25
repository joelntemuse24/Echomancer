/**
 * Offline take-home generation: section-by-section TTS → R2 → progress.
 */

import { downloadFile, uploadFile } from "@/lib/storage";
import { execute, queryOne } from "@/lib/turso";
import { updateJob, logUsage } from "@/lib/turso/jobs";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import { splitTextForTts } from "@/lib/tts/split-text";
import type { JobSegment } from "@/lib/tts/types";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";

const SECTIONS_PER_TICK = Number(process.env.TTS_SECTIONS_PER_TICK || "3");

export interface StockJobRow {
  id: string;
  status: string;
  pdf_storage_path: string;
  book_title: string;
  voice_name: string | null;
  tts_provider: string | null;
  provider_voice_id: string | null;
  catalog_voice_id: string | null;
  tts_options: string | null;
  segments_json: string | null;
  next_section_index: number | null;
  total_sections: number | null;
  char_count: number | null;
  job_kind: string | null;
  generation_mode: string | null;
}

async function loadBookText(pdfStoragePath: string): Promise<string> {
  const buf = await downloadFile(pdfStoragePath);
  return buf.toString("utf-8");
}

function parseSegments(json: string | null): JobSegment[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as JobSegment[];
  } catch {
    return [];
  }
}

export async function processTakehomeTick(jobId: string): Promise<{
  done: boolean;
  nextIndex: number;
  total: number;
}> {
  await ensureTtsJobColumns();

  const job = await queryOne<StockJobRow>(
    `SELECT id, status, pdf_storage_path, book_title, voice_name,
            tts_provider, provider_voice_id, catalog_voice_id, tts_options,
            segments_json, next_section_index, total_sections, char_count,
            job_kind, generation_mode
     FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );

  if (!job) throw new Error("Job not found");
  if (job.status === "ready" || job.status === "failed") {
    return {
      done: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }

  const providerId = job.tts_provider || "";
  if (!isStockProvider(providerId)) {
    throw new Error(`Invalid stock provider: ${providerId}`);
  }

  const catalog = job.catalog_voice_id
    ? await getCatalogVoice(job.catalog_voice_id)
    : undefined;
  const voiceId = job.provider_voice_id || catalog?.providerVoiceId;
  if (!voiceId) throw new Error("Missing provider_voice_id");

  let ttsOptions: { model?: string } = {};
  if (job.tts_options) {
    try {
      ttsOptions = JSON.parse(job.tts_options) as { model?: string };
    } catch {
      /* ignore */
    }
  }
  const modelSlug = ttsOptions.model || catalog?.model;

  const maxChars =
    catalog?.maxCharsPerRequest ||
    (modelSlug?.includes("openai")
      ? 4000
      : modelSlug?.includes("gemini")
        ? 3000
        : modelSlug?.includes("zonos")
          ? 350
          : modelSlug?.includes("kokoro")
            ? 800
            : providerId === "grok"
              ? 12000
              : providerId === "gemini"
                ? 2800
                : 2000);

  const text = await loadBookText(job.pdf_storage_path);
  const sections = splitTextForTts(text, maxChars);
  const total = sections.length;

  if (total === 0) {
    await updateJob(jobId, {
      status: "failed",
      error_message: "No text to synthesize",
    });
    return { done: true, nextIndex: 0, total: 0 };
  }

  let nextIndex = job.next_section_index ?? 0;
  let segments = parseSegments(job.segments_json);

  if (!job.total_sections || job.total_sections !== total) {
    await execute(
      `UPDATE jobs SET total_sections = ?, char_count = ?, status = 'processing',
       updated_at = unixepoch() WHERE id = ?`,
      [total, text.length, jobId]
    );
  } else if (job.status === "queued") {
    await updateJob(jobId, { status: "processing" });
  }

  const provider = resolveStockAdapter({
    provider: providerId,
    model: modelSlug,
  });
  const end = Math.min(nextIndex + SECTIONS_PER_TICK, total);

  for (let i = nextIndex; i < end; i++) {
    const existing = segments.find((s) => s.index === i && s.status === "ready");
    if (existing) continue;

    const sectionText = sections[i]!;
    try {
      const result = await provider.synthesize({
        text: sectionText,
        voiceId,
        language: catalog?.locale,
        model: modelSlug,
        stylePrompt:
          "Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.",
      });

      const ext = result.contentType.includes("wav")
        ? "wav"
        : result.contentType.includes("ogg")
          ? "ogg"
          : "mp3";
      const filename = `sections/${String(i).padStart(4, "0")}.${ext}`;
      const uploaded = await uploadFile(
        `audiobooks/${jobId}`,
        filename,
        result.audio,
        result.contentType
      );

      const segment: JobSegment = {
        index: i,
        path: uploaded.path,
        status: "ready",
        durationSeconds: result.durationHintSeconds,
      };
      segments = [...segments.filter((s) => s.index !== i), segment].sort(
        (a, b) => a.index - b.index
      );

      nextIndex = i + 1;
      const progress = Math.min(99, Math.round((nextIndex / total) * 100));

      await execute(
        `UPDATE jobs SET next_section_index = ?, segments_json = ?, progress = ?,
         current_section = ?, total_sections = ?, status = 'processing',
         updated_at = unixepoch() WHERE id = ?`,
        [
          nextIndex,
          JSON.stringify(segments),
          progress,
          nextIndex,
          total,
          jobId,
        ]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "TTS failed";
      console.error(`[Job ${jobId}] section ${i} failed:`, message);
      await updateJob(jobId, {
        status: "failed",
        error_message: `Section ${i}: ${message}`,
      });
      return { done: true, nextIndex: i, total };
    }
  }

  if (nextIndex >= total) {
    // Prefer first segment as playable path; multi-file playlist via segments_json
    const first = segments.find((s) => s.index === 0 && s.status === "ready");
    const audioPath = first?.path || segments[0]?.path || null;

    await execute(
      `UPDATE jobs SET status = 'ready', progress = 100, next_section_index = ?,
       segments_json = ?, audio_storage_path = COALESCE(audio_storage_path, ?),
       current_section = ?, total_sections = ?, updated_at = unixepoch()
       WHERE id = ?`,
      [total, JSON.stringify(segments), audioPath, total, total, jobId]
    );

    await logUsage({
      action: "takehome_complete",
      charsProcessed: text.length,
    });

    return { done: true, nextIndex: total, total };
  }

  return { done: false, nextIndex, total };
}

/**
 * Fire-and-forget chain to continue processing (self-call with secret).
 */
export async function scheduleTakehomeContinue(jobId: string): Promise<void> {
  let base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  base = base.replace(/\/$/, "");

  const secret = process.env.INTERNAL_JOB_SECRET || "";

  // Don't await the full chain — just kick the next tick
  fetch(`${base}/api/jobs/${jobId}/process`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({}),
  }).catch((err) => {
    console.error(`[Job ${jobId}] failed to schedule continue:`, err);
  });
}
