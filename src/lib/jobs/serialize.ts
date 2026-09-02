/**
 * The single JSON shape the browser sees for a job.
 *
 * Kept in one place because list and detail responses feed the same client
 * types — and because it is the boundary that decides what stays private:
 * internal storage keys are converted to `/api/storage/…` proxy URLs, and
 * columns like `pdf_storage_path`, `tts_options` or lease bookkeeping are never
 * serialized at all.
 */

import {
  estimateJobEtaSeconds,
  estimateElapsedSeconds,
  formatFriendlyGenerationEta,
  formatElapsedSeconds,
} from "@/lib/tts/eta";

export interface SerializedJob {
  id: string;
  book_title: unknown;
  voice_name: unknown;
  status: unknown;
  progress: unknown;
  current_section: unknown;
  total_sections: unknown;
  duration_seconds: unknown;
  error_message: unknown;
  generation_mode: unknown;
  job_kind: unknown;
  tts_provider: unknown;
  provider_voice_id: unknown;
  catalog_voice_id: unknown;
  char_count: unknown;
  stream_cursor: unknown;
  stream_chars_used: unknown;
  stream_max_chars: unknown;
  segments: unknown;
  price_estimate_eur: unknown;
  parent_job_id: unknown;
  audio_url?: string;
  stream_url?: string;
  eta_seconds: number | null;
  eta_label: string | null;
  elapsed_seconds: number | null;
  elapsed_label: string | null;
  created_at: string;
  updated_at: string;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function serializeJob(job: Record<string, unknown>): SerializedJob {
  let segments: unknown = null;
  if (typeof job.segments_json === "string" && job.segments_json) {
    try {
      const parsed = JSON.parse(job.segments_json);
      segments = Array.isArray(parsed)
        ? [...parsed].sort(
            (a: { index?: number }, b: { index?: number }) =>
              (Number(a?.index) || 0) - (Number(b?.index) || 0)
          )
        : parsed;
    } catch {
      segments = null;
    }
  }

  const createdAt = num(job.created_at) ?? 0;
  const updatedAt = num(job.updated_at) ?? 0;
  const generationStartedAt = num(job.generation_started_at);
  const currentSection = num(job.current_section);

  const etaSeconds = estimateJobEtaSeconds({
    status: String(job.status),
    current_section: currentSection,
    total_sections: num(job.total_sections),
    progress: num(job.progress),
    generation_started_at: generationStartedAt,
    created_at: createdAt,
    char_count: num(job.char_count),
  });
  const elapsedSeconds = estimateElapsedSeconds({
    status: String(job.status),
    generation_started_at: generationStartedAt,
    created_at: createdAt,
  });

  return {
    id: String(job.id),
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
    eta_seconds: etaSeconds,
    eta_label: formatFriendlyGenerationEta(etaSeconds, {
      sectionsDone: currentSection,
      live: (currentSection ?? 0) >= 2,
    }),
    elapsed_seconds: elapsedSeconds,
    elapsed_label: formatElapsedSeconds(elapsedSeconds),
    created_at: new Date(createdAt * 1000).toISOString(),
    updated_at: new Date(updatedAt * 1000).toISOString(),
  };
}
