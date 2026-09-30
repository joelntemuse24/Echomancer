/**
 * Plain-language copy for the YouTube clip flow.
 * Shared by the picker so a failure is never a raw stack.
 */

export const YOUTUBE_COPY = {
  searchPlaceholder: "Paste a YouTube link or search, like Allan Bloom lecture",
  search: "Search",
  searching: "Searching…",
  noResults: "No videos found. Try different words, or upload a file.",
  signInToSearch: "Sign in to search YouTube. You can still paste a link.",
  searchUnavailable:
    "Search isn't available right now. Paste a YouTube link, or upload a file.",
  rangeLabel: "Clip start and end",
  consent:
    "I have the right to use this voice (it's me, I have permission, or it's for personal use)",
  useClip: "Use this clip",
  shareHint: "Tick Share tab audio.",
  workingRecord: "Recording",
  workingClone: "Creating your voice…",
  uploadInstead: "Upload a file instead",
  orUpload: "or upload a recording",
  needTabAudio:
    "That share didn't include the tab's sound. Try again and turn on Share tab audio.",
  shareCancelled: "Share was cancelled. You can try again, or upload a file.",
  didntPlay:
    "The video didn't play, so there was nothing to record. Start it in the player, then try again.",
  previewFailed:
    "The preview player couldn't start. You can still set the clip, or upload a file.",
  unsupported:
    "This browser can't record a tab's sound. Upload a file, or record with your microphone while the clip plays somewhere you can hear it.",
  recordMic: "Record with your microphone",
  stopMic: "Stop recording",
  recordingMic: "Recording…",
  micTooShort: "Record at least 10 seconds.",
  micNeedPermission: "The microphone wasn't allowed. You can upload a file instead.",
  unavailable: "YouTube isn't available right now. Upload a file instead.",
  music:
    "That stretch is mostly music. Drag the handles to a part where one person is speaking on their own.",
  overlap:
    "More than one person is talking at once in that stretch. Move it to a part with a single voice.",
  shortSpeech:
    "There isn't enough clear speech in that stretch (we need about 8 seconds). Lengthen the clip or move it.",
  rangeInvalid: "The clip needs to be between 10 and 60 seconds.",
  consentRequired: "Confirm you have the right to use this voice before cloning.",
  pastEnd: "That range goes past the end of the video.",
  badOrder: "The clip end has to be after the start.",
} as const;
