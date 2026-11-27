import { versionedAudioUrl } from "@/lib/player/playback-url";
import { playbackAllowed } from "@/lib/library/card-play";
import {
  availableBookSeconds,
  bookTimeFromElement,
  contiguousSpans,
  decideResume,
  placeOnTimeline,
  sectionBookSpans,
} from "@/lib/player/playback-position";

type Segment = {
  index: number;
  path: string;
  status: string;
  durationSeconds?: number | null;
};

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
  // full.mp3 while the book is still generating is only the published
  // prefix. It ends, and a browser that cannot append MPEG never leaves
  // it. Section files keep going. The finished file is the source once
  // the book is ready.
  if (job.audio_url && !opts.forceSegments && job.status === "ready") {
    const url = versionedAudioUrl(job.audio_url, job.updated_at);
    return url ? { url, segmentIndex: null } : null;
  }
  const first = ready.get(0);
  if (first && (opts.forceSegments || job.status === "processing" || !job.audio_url)) {
    return { url: `/api/storage/${first.path}`, segmentIndex: 0 };
  }
  if (first) return { url: `/api/storage/${first.path}`, segmentIndex: 0 };
  return null;
}

export type ResumeSeed = SeededPlayback & {
  /** Seconds on the file this URL points at. 0 is the start of that file. */
  localSeconds: number;
  /** The stored spot was the end of a finished book, so the next open starts over. */
  restart: boolean;
};

/**
 * Where the player opens. A stored book-clock position picks the part (or
 * the finished file) and the offset inside it. Without one, this is the
 * same source {@link seededTakehomePlayback} would start at 0.
 */
export function playbackForResume(
  job: CachedJobPlayback & { duration_seconds?: number | null } | null | undefined,
  saved: { positionSeconds: number; sectionIndex: number | null } | null,
  opts: { forceStream: boolean; forceSegments: boolean }
): ResumeSeed | null {
  if (!playbackAllowed(job?.status)) return null;
  const base = seededTakehomePlayback(job, opts);
  if (!base) return null;
  const opened: ResumeSeed = { ...base, localSeconds: 0, restart: false };
  if (!saved) return opened;

  // The stored offset belongs to that section file. Open it while the book
  // is still generating, including when a hole still sits in front of it.
  // A finished book recomputes book time from the measured lengths below.
  if (saved.sectionIndex != null && job?.status !== "ready") {
    const ready = new Map<number, Segment>();
    for (const segment of job?.segments ?? []) {
      if (segment.status === "ready" && segment.path) ready.set(segment.index, segment);
    }
    const section = ready.get(saved.sectionIndex);
    if (section) {
      return {
        url: `/api/storage/${section.path}`,
        segmentIndex: saved.sectionIndex,
        localSeconds: Math.max(0, saved.positionSeconds),
        restart: false,
      };
    }
  }

  const spans =
    saved.sectionIndex != null
      ? sectionBookSpans(job?.segments ?? [])
      : contiguousSpans(job?.segments ?? []);
  const complete = job?.status === "ready";
  const duration =
    typeof job?.duration_seconds === "number" && job.duration_seconds > 0
      ? job.duration_seconds
      : null;
  let bookSeconds = saved.positionSeconds;
  let absolute = saved.sectionIndex == null;
  if (saved.sectionIndex != null) {
    const mapped = bookTimeFromElement({
      mode: "section",
      elementSeconds: saved.positionSeconds,
      sectionIndex: saved.sectionIndex,
      spans,
    });
    if (mapped.absolute) {
      bookSeconds = mapped.seconds;
      absolute = true;
    }
  }

  if (!absolute && saved.sectionIndex != null) {
    const ready = new Map<number, Segment>();
    for (const segment of job?.segments ?? []) {
      if (segment.status === "ready" && segment.path) ready.set(segment.index, segment);
    }
    const section = ready.get(saved.sectionIndex);
    if (!section) return opened;
    return {
      url: `/api/storage/${section.path}`,
      segmentIndex: saved.sectionIndex,
      localSeconds: Math.max(0, saved.positionSeconds),
      restart: false,
    };
  }

  const fullFile = base.segmentIndex == null && !base.url.includes("/sections/");
  const decision = decideResume({
    playbackAllowed: true,
    positionSeconds: bookSeconds,
    durationSeconds: duration,
    availableSeconds:
      fullFile && duration ? duration : availableBookSeconds(spans, duration, complete),
    complete,
  });
  if (decision.kind === "ignore") return null;
  if (decision.kind === "restart") return { ...opened, restart: true };
  if (decision.kind !== "restore") return opened;

  if (fullFile) {
    return { ...opened, localSeconds: decision.seconds };
  }
  const placed = placeOnTimeline({ bookSeconds: decision.seconds, spans });
  if (!placed) return { ...opened, localSeconds: decision.seconds };
  const ready = new Map<number, Segment>();
  for (const segment of job?.segments ?? []) {
    if (segment.status === "ready" && segment.path) ready.set(segment.index, segment);
  }
  const section = ready.get(placed.sectionIndex);
  if (!section) return opened;
  return {
    url: `/api/storage/${section.path}`,
    segmentIndex: placed.sectionIndex,
    localSeconds: placed.localSeconds,
    restart: false,
  };
}
