/**
 * Whether a library card or the player may offer playback.
 * A failed book keeps its failed state even when a section file or a stream
 * url is still on the row. Every play path uses {@link playbackAllowed}.
 */
export type PlaybackJob = {
  status: string;
  job_kind?: string | null;
  segments?: Array<{ status?: string | null }> | null;
};

/** One rule for the transport, parts list, media session, and audio url. */
export function playbackAllowed(status: string | null | undefined): boolean {
  return status !== "failed";
}

export function libraryCardCanPlay(job: PlaybackJob): boolean {
  if (!playbackAllowed(job.status)) return false;
  return (
    job.status === "ready" ||
    job.job_kind === "stream" ||
    (job.segments?.some((segment) => segment.status === "ready") ?? false)
  );
}

export function libraryCardCanOpen(job: PlaybackJob): boolean {
  return (
    libraryCardCanPlay(job) ||
    job.status === "processing" ||
    job.status === "queued" ||
    job.status === "waiting"
  );
}

/** The player transport, focus transport, and transcript "Play from here". */
export function playerShowsPlay(status: string | null | undefined): boolean {
  return playbackAllowed(status);
}

/** A ready part can start audio only while the book itself may play. */
export function partRowCanPlay(
  status: string | null | undefined,
  segmentReady: boolean
): boolean {
  return playbackAllowed(status) && segmentReady;
}

export function partRowLabel(
  status: string | null | undefined,
  segmentReady: boolean
): string {
  if (!playbackAllowed(status)) return "Unavailable";
  return segmentReady ? "Ready" : "Generating…";
}

/** Lock-screen controls stay off for a failed book, even if a url is still set. */
export function mediaSessionActive(
  status: string | null | undefined,
  hasAudioUrl: boolean
): boolean {
  return playbackAllowed(status) && hasAudioUrl;
}

/**
 * Drop a playback url when the book must not play. Used when the page first
 * loads already failed and when a later poll or tap would attach a section.
 */
export function playbackUrlForStatus(
  status: string | null | undefined,
  url: string | null
): string | null {
  if (!playbackAllowed(status)) return null;
  return url;
}
