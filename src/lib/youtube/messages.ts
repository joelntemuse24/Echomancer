/**
 * Plain-language copy for the YouTube clip flow.
 * Shared by the picker so a failure is never a raw stack.
 */

export const YOUTUBE_COPY = {
  searchPlaceholder: "YouTube link or search",
  search: "Search",
  searching: "Searching…",
  noResults: "No videos. Try other words.",
  signInToSearch: "Sign in to search. A pasted link still works.",
  searchUnavailable: "Search is off. Paste a link.",
  rangeLabel: "Clip length",
  consent: "I can use this voice.",
  useClip: "Use this clip",
  starting: "Starting",
  fetching: "Fetching the clip",
  preparing: "Preparing the voice",
  proxyBudget: "Download limit reached.",
  proxyRestricted: "That video is blocked here.",
  proxyUnavailable: "Video not found. Try another.",
  proxyTimeout: "Download took too long.",
  proxyFailed: "Couldn't download that clip.",
  workingClone: "Creating…",
  uploadInstead: "Upload a file",
  orUpload: "Upload a recording",
  previewFailed: "Player didn't start. Set the clip anyway.",
  unavailable: "YouTube isn't available right now.",
  music:
    "Mostly music. Move the clip to one person speaking.",
  overlap: "More than one voice. Move the clip to a single voice.",
  shortSpeech: "Not enough speech. Lengthen the clip or move it.",
  rangeInvalid: "The clip needs to be between 10 and 40 seconds.",
  consentRequired: "Confirm you can use this voice.",
  pastEnd: "That range goes past the end of the video.",
  badOrder: "The clip end has to be after the start.",
  tooShortVideo: "Shorter than 10 seconds. Pick another.",
  searchField: "YouTube link or search",
  results: "Results",
  loading: "Loading…",
} as const;

export function proxyClipErrorCopy(code?: string | null): string {
  if (code === "budget") return YOUTUBE_COPY.proxyBudget;
  if (code === "restricted") return YOUTUBE_COPY.proxyRestricted;
  if (code === "unavailable") return YOUTUBE_COPY.proxyUnavailable;
  if (code === "timeout") return YOUTUBE_COPY.proxyTimeout;
  return YOUTUBE_COPY.proxyFailed;
}
