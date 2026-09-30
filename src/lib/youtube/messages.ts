/**
 * Plain-language copy for the YouTube clip flow.
 * Shared by the picker and the worker so a failure is never a raw stack.
 */

export const YOUTUBE_COPY = {
  searchPlaceholder: "Paste a YouTube link or search, like Allan Bloom lecture",
  search: "Search",
  searching: "Searching…",
  noResults: "No videos found. Try different words, or upload a file.",
  searchUnavailable:
    "Search isn't available right now. Paste a YouTube link, or upload a file.",
  rangeHint:
    "Drag the handles. Playback jumps to the start so you hear this stretch.",
  rangeLabel: "Clip start and end",
  consent:
    "I have the right to use this voice (it's me, I have permission, or it's for personal use)",
  useClip: "Use this clip",
  workingGet: "Getting the clip…",
  workingClean: "Cleaning it…",
  workingClone: "Creating your voice…",
  uploadInstead: "Upload a file instead",
  orUpload: "or upload a recording",
  fetchFailed:
    "We couldn't get the audio from that video. Upload a file instead — same screen, just below.",
  previewFailed:
    "The preview player couldn't start. You can still set the clip, or upload a file.",
  unavailable:
    "YouTube isn't available right now. Upload a file instead.",
  music:
    "That stretch is mostly music. Drag the handles to a part where one person is speaking on their own.",
  overlap:
    "More than one person is talking at once in that stretch. Move it to a part with a single voice.",
  shortSpeech:
    "There isn't enough clear speech in that stretch (we need about 8 seconds). Lengthen the clip or move it.",
  separateFailed:
    "That stretch has music under the voice, and we couldn't pull the voice out cleanly. Pick a quieter speaking part, or upload a file.",
  rangeInvalid: "The clip needs to be between 10 and 60 seconds.",
  consentRequired: "Confirm you have the right to use this voice before cloning.",
  pastEnd: "That range goes past the end of the video.",
  badOrder: "The clip end has to be after the start.",
} as const;
