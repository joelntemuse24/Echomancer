/**
 * Customer-facing product language.
 * Prefer these over internal terms (stream / takehome / budget).
 */

export const UX = {
  tryChapter: "Try a chapter",
  tryChapterShort: "Try chapter",
  wholeBook: "Get the whole book",
  wholeBookShort: "Whole book",

  startListening: "Start listening",
  saveFullBook: "Save full audiobook",
  fullBookStarted: "Generating your full audiobook…",
  startingChapter: "Opening your chapter…",

  listening: "Listening",
  savedBook: "Full audiobook",
  ready: "Ready",
  generating: "Generating",
  starting: "Starting",
  failed: "Failed",
  cancelled: "Cancelled",
  readyToPlay: "Ready to play",

  listeningTimeUsed: "Listening time used",
  listeningLimitReached:
    "Listening limit reached. Save the full audiobook to keep going.",
  listeningPaused:
    "Listening paused. Save the full audiobook to keep the whole book.",
  continuing: "Continuing…",
  preparingAudio: "Preparing audio…",
  openingBook: "Opening your book…",
  preparingNarrator: "Preparing narrator…",
  almostReady: "Almost ready…",
  stillWarming:
    "Still warming up — try another narrator if this takes too long.",
  seekingUnavailable: "Chapter · seeking unavailable",

  previewHint: "Preview is one short line so you can compare voices quickly.",
  tryChapterBlurb:
    "Fast narrators for a quick sample of your book — about an hour of listening.",
  wholeBookBlurb:
    "More narrators for a complete downloadable audiobook, including richer HD voices when available.",

  recentlyHeard: "Recently heard",
  compare: "Compare",
} as const;

export type LibraryStatus =
  | "ready"
  | "generating"
  | "starting"
  | "failed"
  | "cancelled"
  | "ready_to_play"
  | "listening";

export function libraryStatus(job: {
  status: string;
  job_kind?: string | null;
  segments?: Array<{ status: string }> | null;
}): { id: LibraryStatus; label: string } {
  // `cancelled` is deliberately distinct from `failed`: nothing went wrong, so
  // offering "Retry" for it would misread the user's intent.
  if (job.status === "cancelled") {
    return { id: "cancelled", label: UX.cancelled };
  }
  if (job.status === "failed") return { id: "failed", label: UX.failed };
  if (job.status === "ready") return { id: "ready", label: UX.ready };
  if (job.job_kind === "stream") {
    return { id: "listening", label: UX.listening };
  }
  if (
    (job.status === "processing" || job.status === "queued") &&
    job.segments?.some((s) => s.status === "ready")
  ) {
    return { id: "ready_to_play", label: UX.readyToPlay };
  }
  if (job.status === "queued") return { id: "starting", label: UX.starting };
  if (job.status === "processing") {
    return { id: "generating", label: UX.generating };
  }
  return { id: "generating", label: UX.generating };
}

export function kindLabel(jobKind?: string | null): string | null {
  if (jobKind === "stream") return "Chapter preview";
  if (jobKind === "takehome") return UX.savedBook;
  return null;
}
