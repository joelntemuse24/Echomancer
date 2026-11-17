/**
 * Whether a library card or the player may offer playback.
 * A failed book keeps its failed state even when a section file or a stream
 * url is still on the row.
 */
export type PlaybackJob = {
  status: string;
  job_kind?: string | null;
  segments?: Array<{ status?: string | null }> | null;
};

export function libraryCardCanPlay(job: PlaybackJob): boolean {
  if (job.status === "failed") return false;
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
  return status !== "failed";
}
