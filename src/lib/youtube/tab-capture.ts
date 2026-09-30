/**
 * Whether this browser can record the current tab's audio.
 * Client-safe. iOS and other mobile browsers cannot; desktop Chromium can.
 */

export type TabCaptureSupport = "supported" | "unsupported";

export function tabAudioCaptureSupport(nav: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  hasGetDisplayMedia: boolean;
}): TabCaptureSupport {
  if (!nav.hasGetDisplayMedia) return "unsupported";
  const ua = nav.userAgent;
  const ios =
    /iPhone|iPad|iPod/.test(ua) ||
    (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
  if (ios) return "unsupported";
  if (/Android|Mobile/i.test(ua)) return "unsupported";
  // Desktop Chromium (Chrome, Edge, Opera, Brave). Firefox and Safari
  // can prompt to share a screen, but they do not capture this tab's audio.
  if (/(Chrome|Chromium|Edg|OPR)\//.test(ua)) return "supported";
  return "unsupported";
}

export function currentTabCaptureSupport(): TabCaptureSupport {
  if (typeof navigator === "undefined") return "unsupported";
  return tabAudioCaptureSupport({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    hasGetDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === "function",
  });
}

/**
 * Tab audio is a soundtrack, not a microphone. Chrome's defaults turn on
 * echo cancellation, noise suppression, and auto gain, which dull and pump
 * the recording. These flags stay off, including local playback.
 */
export const TAB_AUDIO_CONSTRAINTS: MediaTrackConstraints & {
  suppressLocalAudioPlayback: boolean;
} = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48_000,
  suppressLocalAudioPlayback: false,
};

/** Opus at 256 kbps. Chrome's unset default is about 128 kbps. */
export const TAB_RECORDER_BITRATE = 256_000;
export const TAB_RECORDER_MIME = "audio/webm;codecs=opus";

/** 720p is enough for YouTube's normal audio track without a long 1080p buffer. */
export const YOUTUBE_EMBED_QUALITY = "hd720";

export function youtubeEmbedPlayerVars(
  origin: string
): Record<string, string | number> {
  return {
    rel: 0,
    modestbranding: 1,
    playsinline: 1,
    origin,
    vq: YOUTUBE_EMBED_QUALITY,
  };
}

/** Chrome share-picker hints. Non-standard fields are cast at the call site. */
export function displayMediaAudioConstraints(): MediaStreamConstraints & {
  preferCurrentTab: true;
  selfBrowserSurface: "include";
  systemAudio: "exclude";
  surfaceSwitching: "exclude";
  monitorTypeSurfaces: "exclude";
} {
  return {
    video: { displaySurface: "browser" } as MediaTrackConstraints,
    audio: TAB_AUDIO_CONSTRAINTS,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    systemAudio: "exclude",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "exclude",
  };
}

const PROCESSING_OFF: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * Re-apply the processing flags. The first getDisplayMedia call sometimes
 * keeps Chrome's voice defaults until applyConstraints runs.
 */
export async function lockTabAudioTrack(track: {
  applyConstraints: (constraints: MediaTrackConstraints) => Promise<void>;
  getSettings: () => MediaTrackSettings;
}): Promise<{ before: MediaTrackSettings; after: MediaTrackSettings }> {
  const before = track.getSettings();
  try {
    await track.applyConstraints(TAB_AUDIO_CONSTRAINTS);
  } catch {
    await track.applyConstraints(PROCESSING_OFF).catch(() => {});
  }
  return { before, after: track.getSettings() };
}

export function tabRecorderOptions(
  isTypeSupported: (mime: string) => boolean
): { mimeType: string; audioBitsPerSecond: number } {
  return {
    mimeType: isTypeSupported(TAB_RECORDER_MIME) ? TAB_RECORDER_MIME : "audio/webm",
    audioBitsPerSecond: TAB_RECORDER_BITRATE,
  };
}

/** Remaining time and 0–1 progress for a clip that has already started. */
export function clipCountdown(
  elapsedSec: number,
  spanSec: number
): { leftSec: number; ratio: number } {
  const span = Math.max(0.1, spanSec);
  const elapsed = Math.min(span, Math.max(0, elapsedSec));
  return {
    leftSec: Math.max(0, Math.ceil(span - elapsed)),
    ratio: elapsed / span,
  };
}

export function streamHasAudio(stream: { getAudioTracks: () => unknown[] }): boolean {
  return stream.getAudioTracks().length > 0;
}

/**
 * Stop once the player reaches the range end, or shortly after the
 * range length if the player clock never moves.
 */
export function recordingShouldStop(input: {
  startSec: number;
  endSec: number;
  currentTime: number;
  elapsedSec: number;
}): boolean {
  if (input.currentTime >= input.endSec - 0.05) return true;
  const span = Math.max(0, input.endSec - input.startSec);
  return input.elapsedSec >= span + 1.5;
}

/** True when the embedded player actually advanced through the range. */
export function playbackAdvanced(startSec: number, latestTime: number): boolean {
  return latestTime >= startSec + 0.4;
}
