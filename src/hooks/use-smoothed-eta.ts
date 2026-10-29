"use client";

/**
 * Client-side smoothing for the server ETA.
 *
 * The server recomputes the estimate on every poll from section timings, so
 * two polls a few seconds apart can disagree by a minute. The previous value
 * is counted down locally and blended with the new one (see `smoothEta`), so
 * the label eases toward the server's number instead of jumping between polls.
 */

import { useEffect, useRef, useState } from "react";
import {
  formatEtaSeconds,
  smoothEta,
  type JobEtaPrevious,
  type JobEtaState,
} from "@/lib/tts/eta";

export interface EtaJob {
  id: string;
  eta_seconds?: number | null;
  eta_label?: string | null;
  eta_state?: JobEtaState | string | null;
}

/** The smoothed estimate plus the server value it was blended from. */
export interface EtaEntry extends JobEtaPrevious {
  serverSeconds: number;
}

export type EtaPrevMap = Map<string, EtaEntry>;

/** Rounded labels change at minute boundaries, so a 10s tick is enough. */
const TICK_MS = 10_000;

/**
 * Label for one job, keeping `map` up to date. Only a live estimate is
 * smoothed; estimating and finalizing labels are the server's own words.
 * A repeated server value only counts the stored estimate down, so renders
 * between polls do not blend the same number in twice.
 */
export function smoothedLabelFor(
  map: EtaPrevMap,
  job: EtaJob,
  now: number
): string | null {
  const serverSeconds = job.eta_seconds;
  if (job.eta_state !== "live" || serverSeconds == null) {
    map.delete(job.id);
    return job.eta_label ?? null;
  }
  const prev = map.get(job.id) ?? null;
  const seconds =
    prev && prev.serverSeconds === serverSeconds
      ? Math.max(0, prev.seconds - Math.max(0, now - prev.at))
      : smoothEta(prev, serverSeconds, now);
  map.set(job.id, { seconds, at: now, serverSeconds });
  return formatEtaSeconds(seconds);
}

/** Live label for a single job: smoothed across polls, refreshed as it ticks down. */
export function useSmoothedEtaLabel(job: EtaJob): string | null {
  const prevRef = useRef<EtaPrevMap>(new Map());
  const [label, setLabel] = useState<string | null>(job.eta_label ?? null);
  const { id: jobId, eta_seconds, eta_label, eta_state } = job;

  useEffect(() => {
    const current = { id: jobId, eta_seconds, eta_label, eta_state };
    const update = () =>
      setLabel(smoothedLabelFor(prevRef.current, current, Date.now() / 1000));
    update();
    // Minute-scale labels only move at their thresholds; a slow tick keeps the
    // page from re-rendering far more often than the text changes.
    if (eta_state !== "live") return;
    const timer = window.setInterval(update, TICK_MS);
    return () => window.clearInterval(timer);
  }, [jobId, eta_seconds, eta_label, eta_state]);

  return label;
}
