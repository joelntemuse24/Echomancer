/**
 * Customer-facing product language.
 * Prefer these over internal terms (stream / takehome / budget).
 */

export const UX = {
  /** Per-voice play control: short stock demo, not the uploaded book. */
  preview: "Preview",
  /** Sequential Standard then Expressive sample. Not the uploaded book. */
  playBoth: "Play both",
  /** Twin reference is wired but the quality gate is still closed. */
  expressiveUnavailable: "Not available yet",
  tryChapter: "Listening",
  tryChapterShort: "Listening",
  wholeBook: "Get the whole book",
  wholeBookShort: "Whole book",
  /** Voice-step primary: Trigger take-home job. Shown as aria-label on the chevron. */
  makeAudiobook: "Make audiobook",
  /** Per-voice choose-this-narrator affordance (row aria-label). */
  useVoice: "Use",
  /** Quiet non-blocking extract status on the voice step. */
  preparingText: "Preparing text…",

  startListening: "Listening",
  /** Short narrator sample (not the book). */
  liveListen: "Preview",
  liveListenStop: "Stop",
  saveFullBook: "Save full audiobook",
  fullBookStarted: "Generating your full audiobook…",
  startingChapter: "Opening…",

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
  /** Shown only until the browser takes the file. Must be replaced, not left up. */
  preparingDownload: "Preparing full audiobook…",
  downloadStarted: "Download started",
  /** iOS opens the file so Share → Save to Files can keep it. */
  downloadOpened: "Opened the audiobook. Save it from the share menu.",
  openingBook: "Opening your book…",
  preparingNarrator: "Preparing narrator…",
  almostReady: "Almost ready…",
  stillWarming:
    "Still warming up — try again in a moment if this takes too long.",
  seekingUnavailable: "Seeking unavailable",

  previewHint: "A short clip of how this narrator sounds — not your book.",
  tryChapterBlurb:
    "Play a short sample of the voice. It is not your book.",
  wholeBookBlurb:
    "Generate a downloadable audiobook with your narrator.",
  narrationDelivery: "Narration delivery",
  narrationDeliveryHint:
    "Auto matches this book. Override if you want sparser pauses or plainer titles.",
  pauseStyle: "Pauses",
  pauseAuto: "Auto",
  pauseSparse: "Sparse",
  pauseNormal: "Normal",
  joinStyle: "Joins",
  joinAuto: "Auto",
  joinShort: "80ms",
  joinSoft: "120ms",
  joinLong: "150ms",
  titleCleanup: "Titles",
  titleAuto: "Auto",
  titleClean: "Clean",
  titleKeep: "Keep",

  recentlyHeard: "Recently heard",
  compare: "Compare",
  cloneSampleTip:
    "Good clones need a dry room and a phone close to your mouth. Cleaning tools won't rescue echo.",
} as const;

/** Quiet lines under the waiting dots. One at a time. */
export const WAIT = {
  ingest: [
    "Reading the pages",
    "Setting the chapters aside",
    "Leaving out what isn't read aloud",
  ],
  generating: [
    "Reading it through",
    "Finding the voice",
    "Keeping the quiet parts quiet",
  ],
} as const;

/** Voice-step fork. Standard is the stock path — never “Classic”. */
export const VOICE_PATH = {
  standardTitle: "Standard",
  cloneTitle: "Clone",
  backToPaths: "Paths",
  noClones: "No clones yet.",
  cloneUnavailable: "Voice cloning isn’t available right now.",
} as const;

/** Landing + chrome verbs. Keep these dry — no immersion copy. */
export const LANDING = {
  createCta: "Create audiobook",
  libraryCta: "Library",
  signInCta: "Sign in",
  signOutCta: "Sign out",
  uploadTab: "Upload",
  pasteTab: "Paste",
} as const;

/** Signed-in account menu. Provider names stay out of the trigger label. */
export const NAV = {
  account: "Account",
  settings: "Settings",
  library: "Library",
  darkMode: "Dark mode",
  signOut: "Sign out",
} as const;

/**
 * Public /privacy statement. Facts only: what the product actually stores.
 */
export const PRIVACY = {
  title: "Privacy",
  intro:
    "Echomancer (https://echomancer.xyz) turns an uploaded book or pasted text into an audiobook you can listen to and download. This page says what we keep in order to do that, and what we do not do with it.",
  accounts:
    "You can use the site with a signed anonymous cookie. That cookie is how we know which library is yours on this browser. It is not an account. Google sign-in stores your name, email, and profile image so we can keep your library on that Google account. Signing in moves this browser’s books onto that account. Signing out starts a fresh anonymous cookie, so the previous library is not left on the shared browser.",
  books:
    "We store uploaded books and pasted text only to generate your audiobook. The file and the text we read from it sit in storage until you delete the book. Deleting a book from your library removes its audio. The uploaded document is removed when no other book of yours still uses it.",
  processing:
    "Book text is sent to third-party AI providers to clean it for listening, to tag how it is read, and to suggest a narrator.",
  audio:
    "A finished audiobook is stored so you can play and download it. A short listening session streams speech and does not keep a full copy. Speech is generated by our text-to-speech provider. We send that provider the words to be spoken and, if you cloned a voice, the reference for that clone.",
  clones:
    "If you clone a voice, we store the audio sample so we can create and use that clone. The sample is not used for anyone else’s books.",
  storage:
    "Audio and documents are stored on Cloudflare R2. Job metadata — title, voice, progress, and the link between a book and your session — is stored in Turso. We do not run a separate advertising or analytics profile on top of that.",
  selling:
    "We do not sell personal data. We do not sell your books, your voice samples, or your email.",
  retention:
    "We keep a book, its audio, and a voice sample for as long as they stay in your library. Delete the book to remove that audiobook. There is no separate expiry timer. Account details from Google stay while you are signed in with that account.",
  review:
    "We may review anonymized processed text and markup to improve narration quality.",
  contact: "Questions: ntemusejoel@gmail.com",
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
  if (jobKind === "takehome") return UX.savedBook;
  return null;
}
