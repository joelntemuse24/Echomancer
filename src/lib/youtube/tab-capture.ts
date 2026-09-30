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
    audio: true,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    systemAudio: "exclude",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "exclude",
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
