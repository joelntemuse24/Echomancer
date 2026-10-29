/**
 * Wall-clock estimates for take-home generation.
 * OpenRouter does not expose per-request ETA for TTS — we estimate from the
 * sections this job has actually finished (and a conservative pre-job
 * heuristic while there is nothing to measure).
 */

import type { CatalogVoice } from "@/lib/tts/types";

/** Seconds of wall clock we expect per TTS section under current poll/tick architecture. */
export function secondsPerSectionHeuristic(
  latencyClass: CatalogVoice["latencyClass"] | string | null | undefined
): number {
  switch (latencyClass) {
    case "fast":
      return 8;
    case "quality":
      return 28;
    case "balanced":
    default:
      return 16;
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

/**
 * Soften early estimates before we have live section timing.
 * Short books often finish faster than the section heuristic suggests.
 */
export function formatFriendlyGenerationEta(
  seconds: number | null | undefined,
  opts?: {
    sectionsDone?: number | null;
    live?: boolean;
    totalSections?: number | null;
    provider?: string | null;
  }
): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const done = Number(opts?.sectionsDone) || 0;
  const total = Number(opts?.totalSections) || 0;
  const multiFish =
    (opts?.provider === "fish" || total > 1) && (total > 1 || seconds >= 45);
  if (!opts?.live && done < 2 && !multiFish) {
    if (seconds < 120) return "usually under a minute";
    if (seconds < 240) return "usually a couple of minutes";
    if (seconds < 600) return "usually under 10 min";
  }
  return formatEtaSeconds(seconds);
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
 * Read a job's server ETA label the same way everywhere: "Estimating…" stands
 * alone, a duration gets a "left" suffix.
 */
export function etaLabelSuffix(
  label: string | null | undefined,
  state?: string | null
): string {
  if (!label) return "";
  return state === "estimating" ? label : `${label} left`;
}

/** Job fields that feed the estimate. All timestamps are epoch seconds. */
export interface JobEtaInput {
  status: string;
  current_section?: number | null;
  total_sections?: number | null;
  progress?: number | null;
  generation_started_at?: number | null;
  created_at?: number | null;
  /** Last write on the row. Only a proxy for the last section: it also moves
   *  on heartbeats and lease bookkeeping. */
  updated_at?: number | null;
  /** Epoch seconds of the first finished section, when a worker records it. */
  first_section_at?: number | null;
  /** Epoch seconds of the most recent finished section, when known. */
  last_section_at?: number | null;
  char_count?: number | null;
  latency_class?: string | null;
  max_chars_per_request?: number | null;
  /** Actual take-home fan-out (1–5). Only divides the heuristic. */
  fanout?: number | null;
  /** Per-section character counts in index order, when the caller has them. */
  section_chars?: readonly number[] | null;
  /** Epoch seconds. Defaults to now; fixed in tests. */
  now?: number | null;
}

export type JobEtaState = "estimating" | "live" | "finalizing" | "done";

export interface JobEta {
  seconds: number | null;
  label: string;
  state: JobEtaState;
}

/** A previous estimate, counted down by the time since it was made. */
export interface JobEtaPrevious {
  seconds: number;
  /** Epoch seconds when `seconds` was produced. */
  at: number;
}

/** Measured throughput needs a window this long before it is trusted. */
const MIN_LIVE_WINDOW_SECONDS = 30;
/** Finished sections needed before the live rate displaces the heuristic. */
const MIN_LIVE_SECTIONS = 3;
const SMOOTHING_ALPHA = 0.3;
/** Largest change per update, as a fraction of the counted-down previous value. */
const MAX_STEP_FRACTION = 0.25;
const FINALIZE_BASE_SECONDS = 15;
const FINALIZE_PER_TEN_SECTIONS_SECONDS = 2;
const FINALIZE_CAP_SECONDS = 10 * 60;
const ETA_CAP_SECONDS = 6 * 60 * 60;
/** A stall makes the estimate grow, but not without bound. */
const STALL_EXCESS_CAP_SECONDS = 30 * 60;

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function heuristicFanout(fanout: number | null | undefined): number {
  const raw = Number(fanout);
  return Number.isFinite(raw) && raw >= 1 ? clamp(Math.floor(raw), 1, 16) : 1;
}

export function finalizeEtaSeconds(finishedSections: number): number {
  const done = Math.max(0, Math.floor(finishedSections));
  const raw =
    FINALIZE_BASE_SECONDS + Math.floor(done / 10) * FINALIZE_PER_TEN_SECTIONS_SECONDS;
  return Math.min(FINALIZE_CAP_SECONDS, raw);
}

function consumedSectionWeight(
  sectionChars: readonly number[] | null | undefined,
  done: number,
  total: number
): { finishedChars: number; remainingChars: number; avgSectionChars: number } {
  const empty = { finishedChars: 0, remainingChars: 0, avgSectionChars: 0 };
  if (!sectionChars || sectionChars.length === 0 || done <= 0) return empty;
  const limit = Math.min(total || sectionChars.length, sectionChars.length);
  const finishedSections = Math.min(done, limit);
  let finishedChars = 0;
  for (let i = 0; i < finishedSections; i++) {
    finishedChars += Math.max(0, finiteOr(sectionChars[i], 0));
  }
  if (finishedChars <= 0) return empty;
  let remainingChars = 0;
  for (let i = finishedSections; i < limit; i++) {
    remainingChars += Math.max(0, finiteOr(sectionChars[i], 0));
  }
  return {
    finishedChars,
    remainingChars,
    avgSectionChars: finishedChars / finishedSections,
  };
}

function finalizeLabel(seconds: number): string {
  return formatEtaSeconds(Math.max(1, Math.round(seconds))) ?? "under a minute";
}

/**
 * Blend a server estimate with the previous one: the previous value is counted
 * down by the elapsed time, blended at {@link SMOOTHING_ALPHA}, then held
 * inside ±25% of the counted-down value. An upward move may instead compare
 * against the previous value, so a spent estimate can still grow.
 */
export function smoothEta(
  prev: JobEtaPrevious | null | undefined,
  serverSeconds: number,
  now: number
): number {
  const server = Math.min(
    ETA_CAP_SECONDS,
    Math.max(1, Number.isFinite(serverSeconds) ? serverSeconds : 1)
  );
  let seconds = server;
  if (prev && Number.isFinite(prev.seconds) && Number.isFinite(prev.at)) {
    const countedDown = Math.max(0, prev.seconds - (now - prev.at));
    // A stale estimate (already counted down to zero) is no anchor at all;
    // keeping it would under-report while work remains.
    if (countedDown > 0) {
      const blended = countedDown * (1 - SMOOTHING_ALPHA) + server * SMOOTHING_ALPHA;
      // Downward moves are measured against the counted-down value; upward
      // moves against the previous estimate, so an exhausted estimate can
      // still grow when the job really is slower than predicted.
      const low = countedDown * (1 - MAX_STEP_FRACTION);
      const high = Math.max(countedDown, prev.seconds) * (1 + MAX_STEP_FRACTION);
      seconds = clamp(blended, low, high);
    }
  }
  return Math.max(1, Math.round(clamp(seconds, 1, ETA_CAP_SECONDS)));
}

/**
 * Estimate the remaining wall clock for a take-home job.
 *
 * The live rate comes from this job alone: sections completed since the first
 * section finished, which excludes queueing and model warm-up. Parallelism is
 * already baked into that measured rate; the heuristic fallback divides by
 * `fanout` (default 1, never an assumed 4).
 *
 * `prev` smooths successive polls: the previous value is counted down by the
 * elapsed time, blended at {@link SMOOTHING_ALPHA}, then held inside ±25% of
 * the counted-down value (an upward move may also use the previous value, so a
 * spent estimate can still grow). Finalizing and done skip smoothing.
 */
export function computeJobEta(
  input: JobEtaInput,
  prev?: JobEtaPrevious | null
): JobEta {
  const now = finiteOr(input.now, Date.now() / 1000);
  const status = String(input.status);

  if (status === "ready" || status === "failed" || status === "cancelled") {
    return { seconds: 0, label: "Done", state: "done" };
  }

  const done = Math.max(0, Math.floor(finiteOr(input.current_section, 0)));
  const total = Math.max(0, Math.floor(finiteOr(input.total_sections, 0)));
  const fanout = heuristicFanout(input.fanout);
  const perSection = secondsPerSectionHeuristic(input.latency_class ?? "balanced");
  const finalize = finalizeEtaSeconds(done);
  const knownTotal = total > 0;
  const remainingSections = knownTotal ? Math.max(0, total - done) : 0;

  // Every section is in: the worker is concatenating / mastering / uploading.
  if (knownTotal && remainingSections === 0) {
    if (status === "ready") {
      return { seconds: 0, label: "Done", state: "done" };
    }
    const seconds = Math.max(1, finalize);
    return { seconds, label: finalizeLabel(seconds), state: "finalizing" };
  }

  const startedAt = Math.max(
    0,
    finiteOr(input.generation_started_at, finiteOr(input.created_at, 0))
  );

  // First finish marks the end of warm-up. Without a recorded timestamp,
  // assume one section's worth of startup after generation began.
  const firstSectionAt =
    finiteOr(input.first_section_at, 0) > 0
      ? finiteOr(input.first_section_at, 0)
      : startedAt > 0
        ? startedAt + perSection / fanout
        : 0;

  const measuredElapsed =
    firstSectionAt > 0 ? Math.max(0, now - firstSectionAt) : 0;
  const samplesSinceFirst = Math.max(0, done - 1);
  const explicitLastSectionAt = finiteOr(input.last_section_at, 0);
  const lastSectionAt =
    explicitLastSectionAt > 0
      ? explicitLastSectionAt
      : finiteOr(input.updated_at, 0);
  // Measure throughput over finished sections only. Silence is handled by
  // stallExcess below; counting it here as well would penalise a stall twice.
  const measuredSpan =
    explicitLastSectionAt > firstSectionAt && firstSectionAt > 0
      ? explicitLastSectionAt - firstSectionAt
      : 0;
  const rateWindow = measuredSpan > 0 ? measuredSpan : measuredElapsed;
  const measuredRate =
    samplesSinceFirst > 0 && rateWindow > 0
      ? samplesSinceFirst / rateWindow
      : 0;

  const live =
    done >= MIN_LIVE_SECTIONS &&
    measuredElapsed >= MIN_LIVE_WINDOW_SECONDS &&
    measuredRate > 0;

  // Remaining work, either in sections or in character-weighted equivalents.
  let remainingWeight: number;
  if (knownTotal) {
    const chars = consumedSectionWeight(input.section_chars, done, total);
    remainingWeight =
      chars.avgSectionChars > 0
        ? chars.remainingChars / chars.avgSectionChars
        : remainingSections;
  } else {
    const chars = Math.max(0, finiteOr(input.char_count, 0));
    remainingWeight =
      chars > 0
        ? estimateSectionCount(chars, finiteOr(input.max_chars_per_request, 800))
        : 0;
  }

  if (remainingWeight <= 0) {
    return { seconds: null, label: "Estimating…", state: "estimating" };
  }

  // A stall is time past 2× the mean interval between finished sections; add
  // the excess so the estimate grows instead of freezing. The mean comes from
  // finished sections only: using "now" would dilute it with the very silence
  // it is meant to detect. Only counts after a first section has landed, since
  // queue wait is already covered by the pre-live heuristic.
  let stallExcess = 0;
  const finishedSpan =
    lastSectionAt > 0 && firstSectionAt > 0
      ? lastSectionAt - firstSectionAt
      : 0;
  const meanInterval =
    samplesSinceFirst > 0 && finishedSpan > 0
      ? finishedSpan / samplesSinceFirst
      : perSection / fanout;
  const silence = lastSectionAt > 0 ? Math.max(0, now - lastSectionAt) : 0;
  if (done >= 1 && startedAt > 0 && silence > meanInterval * 2) {
    // Cap the penalty so a job parked overnight does not show days remaining;
    // the overall ETA cap still applies.
    stallExcess = Math.min(
      STALL_EXCESS_CAP_SECONDS,
      silence - meanInterval * 2
    );
  }

  const raw =
    (live ? remainingWeight / measuredRate : (remainingWeight * perSection) / fanout) +
    finalize +
    stallExcess;
  const capped = Math.min(ETA_CAP_SECONDS, Math.max(1, raw));
  const seconds = smoothEta(prev, capped, now);

  if (!live) {
    return { seconds, label: "Estimating…", state: "estimating" };
  }
  return {
    seconds,
    label: formatEtaSeconds(seconds) ?? "under a minute",
    state: "live",
  };
}

/**
 * Live ETA from observed section progress. Null while there is not enough
 * progress to measure.
 */
export function estimateLiveEtaSeconds(job: JobEtaInput): number | null {
  const eta = computeJobEta(job);
  if (eta.state === "live" || eta.state === "finalizing") return eta.seconds;
  return null;
}

/** Best ETA for a job. Null once the job is no longer running. */
export function estimateJobEtaSeconds(job: JobEtaInput): number | null {
  const eta = computeJobEta(job);
  return eta.state === "done" ? null : eta.seconds;
}
