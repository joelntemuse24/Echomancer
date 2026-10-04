/**
 * Customer-facing product language.
 * Prefer these over internal terms (stream / takehome / budget).
 */

export const UX = {
  /** Per-voice play control: short stock demo, not the uploaded book. */
  preview: "Play",
  /** Voice-step primary. Visible label on the continue control. */
  makeAudiobook: "Make audiobook",

  liveListenStop: "Stop",
  saveFullBook: "Save the book",
  fullBookStarted: "Saving the book…",

  listening: "Listening",
  ready: "Ready",
  generating: "Generating",
  starting: "Generating",
  failed: "Failed",
  cancelled: "Cancelled",
  readyToPlay: "Ready to play",

  listeningPaused: "This listen stops here. Save the book.",
  /** iOS opens the file so Share → Save to Files can keep it. */
  downloadOpened: "Save it from the share menu.",
} as const;

/** One quiet line under the waiting dots. */
export const WAIT = {
  ingest: ["Reading your book"],
  generating: ["Making the audiobook"],
} as const;

/** Voice step. Stock names stay on screen; clone is a row under them. */
export const VOICE_PATH = {
  title: "Voice",
  cloneTitle: "Clone a voice",
  yourVoices: "Your voices",
  cloneUnavailable: "Cloning isn't available right now.",
  stockUnavailable: "Voices aren't available right now.",
} as const;

/** Landing + chrome verbs. Keep these dry — no immersion copy. */
export const LANDING = {
  createCta: "Choose a voice",
  signInCta: "Sign in",
  uploadTab: "Upload",
  pasteTab: "Paste",
  pasteTextOption: "Text",
  pasteUrlOption: "Link",
  pasteUrlPlaceholder: "https://",
} as const;

/** /sign-in and the emailed-link confirm page. */
export const SIGN_IN = {
  title: "Sign in",
  google: "Google",
  emailPlaceholder: "you@example.com",
  emailCta: "Email a link",
  emailSending: "Sending…",
  sentTitle: "Check your inbox",
  sentBody: "A link is coming. Once, for 15 minutes.",
  sentRetry: "Different address",
  divider: "or",
  expired: "That link expired. Request a new one.",
  invalid: "Sign-in didn't finish. Request a new link.",
  confirmTitle: "Sign in",
  confirmBody: "Books on this browser will move to your account.",
  confirmCta: "Sign in",
  confirmMissing: "This link is incomplete. Request a new one.",
  unavailable: "Sign-in isn't available right now.",
} as const;

/** Signed-in account menu. Provider names stay out of the trigger label. */
export const NAV = {
  account: "Account",
  settings: "Settings",
  voices: "Voices",
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
    "Echomancer turns a book, pasted text, or a link into an audiobook.",
  accounts:
    "A cookie on this browser holds your library until you sign in. It is not an account. Google stores your name, email, and photo. Email stores your address and one link, sent by Resend. One address is one account. Signing in moves those books. Signing out starts a new cookie.",
  books:
    "We keep the file and its text until you delete the book. Deleting removes the audio. The file goes when nothing else of yours uses it.",
  processing:
    "We send the text out to clean it, suggest a narrator, and speak it.",
  audio:
    "A short listen is not saved in full. The finished book is, so you can play and download it. A clone also sends that voice.",
  clones: "A voice sample is only for your clone. Not for anyone else's books.",
  storage:
    "Audio and files are on Cloudflare (R2). Title, voice, and progress are in Turso. No ad profile.",
  selling: "We don't sell your data, books, voice, or email.",
  retention:
    "Books, audio, and samples stay until you delete them. No expiry. Google details stay while you are signed in.",
  review: "We may review anonymized text to improve narration.",
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
    (job.status === "processing" ||
      job.status === "queued" ||
      job.status === "waiting") &&
    job.segments?.some((s) => s.status === "ready")
  ) {
    return { id: "ready_to_play", label: UX.readyToPlay };
  }
  if (
    job.status === "queued" ||
    job.status === "waiting" ||
    job.status === "processing"
  ) {
    return { id: "generating", label: UX.generating };
  }
  return { id: "generating", label: UX.generating };
}
