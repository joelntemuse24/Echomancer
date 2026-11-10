import { versionedAudioUrl } from "@/lib/player/playback-url";

type Segment = { index: number; path: string; status: string };

export type CachedJobPlayback = {
  job_kind?: string | null;
  status?: string | null;
  audio_url?: string | null;
  updated_at?: string | null;
  segments?: Segment[] | null;
};

export type SeededPlayback = {
  url: string;
  /** Set when the source is one section. A finished file keeps the player's index. */
  segmentIndex: number | null;
};

/**
 * Audio a library row can start before the player detail request returns.
 * A stream is left unset: opening it starts a connection the detail
 * request would open again.
 */
export function seededTakehomePlayback(
  job: CachedJobPlayback | null | undefined,
  opts: { forceStream: boolean; forceSegments: boolean }
): SeededPlayback | null {
  if (!job || opts.forceStream || job.job_kind === "stream") return null;
  const ready = new Map<number, Segment>();
  for (const segment of job.segments ?? []) {
    if (segment.status === "ready" && segment.path) ready.set(segment.index, segment);
  }
  const first = ready.get(0);
  if (first && (opts.forceSegments || job.status === "processing" || !job.audio_url)) {
    return { url: `/api/storage/${first.path}`, segmentIndex: 0 };
  }
  if (job.audio_url) {
    const url = versionedAudioUrl(job.audio_url, job.updated_at);
    return url ? { url, segmentIndex: null } : null;
  }
  if (first) return { url: `/api/storage/${first.path}`, segmentIndex: 0 };
  return null;
}
