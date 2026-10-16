/**
 * Playback clock for a live stream.
 *
 * The stream body is one MP3 (or WAV) response with no timing inside it, and
 * the delivery cursor runs ahead of what the listener hears. The stream
 * session therefore records, per synthesis window, the text range it narrates
 * and the audio seconds it measured once the window was fully delivered. The
 * windows play back to back, so the cumulative measured seconds are the
 * element's `currentTime` for each window start. Inside a window, time maps
 * over sentence weights, the same approach finished books use. A window that
 * has not been measured yet borrows the measured seconds-per-character rate
 * until its real duration arrives. Before any window is measured the
 * highlight rests on the first sentence of the first window, so it never
 * runs ahead of audio whose length is unknown.
 *
 * `currentTime` is media time, so pause, buffering and playback rate need no
 * handling here. A reconnect starts a new audio timeline, so a timeline only
 * applies to the connection (`conn`) that wrote it.
 */

import {
  sentenceWeights,
  type ReadAlongDocument,
  type TranscriptSection,
} from "@/lib/player/read-along";

export interface StreamTimelineWindow {
  /** Offsets into the speakable text the transcript is built from. */
  start: number;
  end: number;
  /** Measured audio length. Null until the window has been fully delivered. */
  seconds: number | null;
}

export interface StreamTimeline {
  /** Client-chosen id of the connection whose audio this timeline describes. */
  conn: string | null;
  windows: StreamTimelineWindow[];
}

export const STREAM_CONN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Speech pace used for a window until any window has been measured. */
const DEFAULT_SECONDS_PER_CHAR = 1 / 15;
const MIN_WINDOW_SECONDS = 0.5;
/** Stands in for a first window of unknown length: the highlight stays put. */
const UNMEASURED_HOLD_SECONDS = 1e6;

export function parseStreamTimeline(raw: unknown): StreamTimeline | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const { conn, windows } = value as Record<string, unknown>;
  if (!Array.isArray(windows)) return null;
  const parsed: StreamTimelineWindow[] = [];
  for (const item of windows) {
    if (!item || typeof item !== "object") return null;
    const { start, end, seconds } = item as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number" || !(end > start) || start < 0) {
      return null;
    }
    const measured = typeof seconds === "number" && seconds > 0 ? seconds : null;
    parsed.push({ start, end, seconds: measured });
  }
  return {
    conn: typeof conn === "string" && STREAM_CONN_PATTERN.test(conn) ? conn : null,
    windows: parsed,
  };
}

export function newStreamConn(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id ? id.replace(/-/g, "") : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function streamUrlWithConn(base: string, conn: string): string {
  return `${base}${base.includes("?") ? "&" : "?"}conn=${encodeURIComponent(conn)}`;
}

/** True when the timeline describes the audio the element is playing. */
export function timelineMatchesConn(
  timeline: StreamTimeline | null | undefined,
  conn: string | null
): timeline is StreamTimeline {
  return Boolean(timeline && conn && timeline.conn === conn && timeline.windows.length > 0);
}

/** Seconds of audio covered by measured windows, counted from the first. */
export function streamCoveredSeconds(timeline: StreamTimeline): number {
  let covered = 0;
  for (const window of timeline.windows) {
    if (window.seconds == null) break;
    covered += window.seconds;
  }
  return covered;
}

const documentTexts = new WeakMap<ReadAlongDocument, string>();

/** The readable text, with blocks at their recorded offsets. */
function documentText(doc: ReadAlongDocument): string {
  const cached = documentTexts.get(doc);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  let at = 0;
  for (const block of doc.blocks) {
    if (block.charStart > at) parts.push("\n".repeat(block.charStart - at));
    parts.push(block.text);
    at = block.charStart + block.text.length;
  }
  const text = parts.join("");
  documentTexts.set(doc, text);
  return text;
}

/**
 * The transcript with one timed section per stream window, ready for the
 * finished-book clock in `charIndexForPlayback` (mode "full").
 */
export function streamClockDocument(
  doc: ReadAlongDocument,
  timeline: StreamTimeline
): ReadAlongDocument {
  const text = documentText(doc);
  const windows = timeline.windows.map((window) => ({
    window,
    sentences: sentenceWeights(text.slice(window.start, window.end)),
  }));
  let measuredSeconds = 0;
  let measuredChars = 0;
  for (const { window, sentences } of windows) {
    if (window.seconds == null) continue;
    measuredSeconds += window.seconds;
    measuredChars += sentences.reduce((sum, sentence) => sum + sentence.weight, 0);
  }
  const rate = measuredChars > 0 ? measuredSeconds / measuredChars : DEFAULT_SECONDS_PER_CHAR;
  const anyMeasured = measuredChars > 0;
  let elapsed = 0;
  const sections: TranscriptSection[] = windows.map(({ window, sentences }, index) => {
    const chars = sentences.reduce((sum, sentence) => sum + sentence.weight, 0);
    const durationSeconds =
      window.seconds ??
      (anyMeasured ? Math.max(MIN_WINDOW_SECONDS, chars * rate) : UNMEASURED_HOLD_SECONDS);
    const section: TranscriptSection = {
      index,
      charStart: window.start,
      charEnd: window.end,
      durationSeconds,
      startSeconds: elapsed,
      sentences,
    };
    elapsed += durationSeconds;
    return section;
  });
  return { ...doc, sections };
}
