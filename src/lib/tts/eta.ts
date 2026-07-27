/**
 * Wall-clock estimates for take-home generation.
 * OpenRouter does not expose per-request ETA for TTS — we estimate from
 * section count + observed progress (and a conservative pre-job heuristic).
 */

import type { CatalogVoice } from "@/lib/tts/types";

/** Seconds of wall clock we expect per TTS section under current poll/tick architecture. */
export function secondsPerSectionHeuristic(
  latencyClass: CatalogVoice["latencyClass"] | string | null | undefined
): number {
  switch (latencyClass) {
    case "fast":
      return 12;
    case "quality":
      return 35;
    case "balanced":
    default:
      return 22;
  }
}

export function estimateSectionCount(
  charCount: number,
  maxCharsPerRequest: number
): number {
  const chunk = Math.max(50, maxCharsPerRequest || 800);
  return Math.max(1, Math.ceil(Math.max(0, charCount) / chunk));
}

/** Pre-job ballpark before generation starts. */
export function estimateTakehomeWallClockSeconds(input: {
  charCount: number;
  maxCharsPerRequest: number;
  latencyClass?: CatalogVoice["latencyClass"] | string | null;
}): { sections: number; seconds: number } {
  const sections = estimateSectionCount(
    input.charCount,
    input.maxCharsPerRequest
  );
  const seconds = Math.round(
    sections * secondsPerSectionHeuristic(input.latencyClass)
  );
  return { sections, seconds };
}

export function formatEtaSeconds(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 45) return "under a minute";
  if (seconds < 90) return "~1 min";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `~${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `~${hours}h` : `~${hours}h ${rem}m`;
}

/** Elapsed wall clock since generation started (for UX transparency). */
export function estimateElapsedSeconds(job: {
  generation_started_at?: number | null;
  created_at?: number | null;
  status?: string;
}): number | null {
  if (
    job.status === "ready" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    return null;
  }
  const started =
    Number(job.generation_started_at) || Number(job.created_at) || 0;
  if (!started) return null;
  return Math.max(0, Math.round(Date.now() / 1000 - started));
}

export function formatElapsedSeconds(
  seconds: number | null | undefined
): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (mins < 60) return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${hours}h` : `${hours}h ${m}m`;
}

/**
 * Live ETA from observed section progress.
 * Requires generation_started_at (or created_at fallback) and at least 2 sections done.
 */
export function estimateLiveEtaSeconds(job: {
  status: string;
  current_section?: number | null;
  total_sections?: number | null;
  progress?: number | null;
  generation_started_at?: number | null;
  created_at?: number | null;
}): number | null {
  if (job.status === "ready" || job.status === "failed" || job.status === "cancelled") {
    return null;
  }
  const total = Number(job.total_sections) || 0;
  const done = Number(job.current_section) || 0;
  if (total <= 0 || done < 2) return null;

  const started =
    Number(job.generation_started_at) || Number(job.created_at) || 0;
  if (!started) return null;

  const elapsed = Math.max(1, Date.now() / 1000 - started);
  const rate = done / elapsed; // sections per second
  if (rate <= 0) return null;

  const remainingSections = Math.max(0, total - done);
  const eta = Math.round(remainingSections / rate);
  // Cap wild outliers (e.g. one fast section then long stall)
  return Math.min(eta, 6 * 60 * 60);
}

/**
 * Best ETA for a job: prefer live rate once we have enough samples,
 * otherwise fall back to remaining-sections × latency heuristic.
 */
export function estimateJobEtaSeconds(job: {
  status: string;
  current_section?: number | null;
  total_sections?: number | null;
  progress?: number | null;
  generation_started_at?: number | null;
  created_at?: number | null;
  char_count?: number | null;
  latency_class?: string | null;
  max_chars_per_request?: number | null;
}): number | null {
  if (job.status === "ready" || job.status === "failed" || job.status === "cancelled") {
    return null;
  }

  const live = estimateLiveEtaSeconds(job);
  if (live != null) return live;

  const total = Number(job.total_sections) || 0;
  const done = Number(job.current_section) || 0;
  let remaining = total > 0 ? Math.max(0, total - done) : 0;

  if (remaining <= 0 && total <= 0) {
    const chars = Number(job.char_count) || 0;
    if (chars <= 0) return null;
    remaining = estimateSectionCount(
      chars,
      Number(job.max_chars_per_request) || 800
    );
  }

  if (remaining <= 0) return null;

  return Math.round(
    remaining * secondsPerSectionHeuristic(job.latency_class ?? "balanced")
  );
}
