/**
 * YouTube URL parsing and clip-range rules.
 * Client-safe: no Node imports. The picker and the worker share these.
 */

import { YOUTUBE_COPY } from "@/lib/youtube/messages";

export const MIN_CLIP_SEC = 10;
export const MAX_CLIP_SEC = 60;
export const DEFAULT_CLIP_SEC = 30;

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

export function isYoutubeVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID.test(value);
}

export function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/** Pull an 11-character video id out of a link, short URL, or bare id. */
export function parseYoutubeVideoId(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (VIDEO_ID.test(text)) return text;

  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return isYoutubeVideoId(id) ? id : null;
  }

  const youtubeHost =
    host === "youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "music.youtube.com";
  if (!youtubeHost) return null;

  const fromQuery = url.searchParams.get("v");
  if (isYoutubeVideoId(fromQuery)) return fromQuery;

  const parts = url.pathname.split("/").filter(Boolean);
  const markers = new Set(["embed", "shorts", "live", "v"]);
  for (let i = 0; i < parts.length - 1; i++) {
    const id = parts[i + 1];
    if (markers.has(parts[i]!) && isYoutubeVideoId(id)) return id;
  }
  return null;
}

/** YouTube `contentDetails.duration` (ISO 8601), in seconds. */
export function parseIso8601Duration(iso: string): number | null {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
    iso.trim()
  );
  if (!match) return null;
  if (match[1] == null && match[2] == null && match[3] == null) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  if (![hours, minutes, seconds].every((n) => Number.isFinite(n))) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return total >= 0 ? total : null;
}

export function roundClipSec(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${minutes}:${ss}`;
}

/**
 * A 30s window past a typical intro. Short videos start at the beginning.
 * This is a suggestion — the worker still rejects music, overlap, and
 * stretches with under ~8s of speech.
 */
export function defaultSpeechRange(
  durationSec: number
): { startSec: number; endSec: number } | null {
  if (!Number.isFinite(durationSec) || durationSec < MIN_CLIP_SEC) return null;
  const length = Math.min(DEFAULT_CLIP_SEC, durationSec);
  let start = 0;
  if (durationSec >= 180) start = 45;
  else if (durationSec >= 60) start = 12;
  if (start + length > durationSec) start = Math.max(0, durationSec - length);
  return {
    startSec: roundClipSec(start),
    endSec: roundClipSec(start + length),
  };
}

export function validateClipRange(
  startSec: number,
  endSec: number,
  durationSec?: number
):
  | { ok: true; startSec: number; endSec: number }
  | { ok: false; message: string } {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    return { ok: false, message: YOUTUBE_COPY.rangeInvalid };
  }
  const start = roundClipSec(startSec);
  const end = roundClipSec(endSec);
  if (start < 0 || end <= start) {
    return { ok: false, message: YOUTUBE_COPY.badOrder };
  }
  const length = roundClipSec(end - start);
  if (length < MIN_CLIP_SEC || length > MAX_CLIP_SEC) {
    return { ok: false, message: YOUTUBE_COPY.rangeInvalid };
  }
  if (
    durationSec != null &&
    Number.isFinite(durationSec) &&
    end > durationSec + 0.25
  ) {
    return { ok: false, message: YOUTUBE_COPY.pastEnd };
  }
  return { ok: true, startSec: start, endSec: end };
}

/**
 * Keep a two-handle drag inside 10–60s and inside the video.
 * `anchor` is the handle the person is moving.
 */
export function clampClipRange(
  startIn: number,
  endIn: number,
  durationSec: number,
  anchor: "start" | "end"
): { startSec: number; endSec: number } | null {
  if (!Number.isFinite(durationSec) || durationSec < MIN_CLIP_SEC) return null;
  const duration = durationSec;
  const maxLen = Math.min(MAX_CLIP_SEC, duration);
  const minLen = MIN_CLIP_SEC;
  let start = Number.isFinite(startIn) ? startIn : 0;
  let end = Number.isFinite(endIn) ? endIn : start + DEFAULT_CLIP_SEC;

  if (end < start) {
    if (anchor === "start") end = start;
    else start = end;
  }
  const length = end - start;
  if (length < minLen) {
    if (anchor === "start") end = start + minLen;
    else start = end - minLen;
  } else if (length > maxLen) {
    if (anchor === "start") end = start + maxLen;
    else start = end - maxLen;
  }

  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > duration) {
    const shift = end - duration;
    end = duration;
    start -= shift;
  }
  if (start < 0) start = 0;
  if (end - start > maxLen) {
    if (anchor === "end") start = end - maxLen;
    else end = Math.min(duration, start + maxLen);
  }
  if (end - start < minLen) {
    end = Math.min(duration, start + minLen);
    start = Math.max(0, end - minLen);
  }
  if (end > duration) end = duration;
  if (start < 0) start = 0;
  if (roundClipSec(end - start) < MIN_CLIP_SEC) return null;

  return { startSec: roundClipSec(start), endSec: roundClipSec(end) };
}

/** yt-dlp `--download-sections` time range. Seconds, not the whole video. */
export function downloadSectionSpec(startSec: number, endSec: number): string {
  const start = roundClipSec(Math.max(0, startSec));
  const end = roundClipSec(endSec);
  return `*${start}-${end}`;
}

/**
 * Upper bound on a section file. A full-video download of a long lecture
 * is far past this; a 60s bestaudio file is not.
 */
export function sectionByteCap(durationSec: number): number {
  const seconds = Math.min(MAX_CLIP_SEC, Math.max(1, durationSec));
  return Math.ceil(seconds * 64_000) + 512_000;
}
