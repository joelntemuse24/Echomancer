/**
 * Optional spoken-heading snap. Off unless a re-chapter run passes
 * `--asr-snap` and `faster-whisper` or `whisper` is on PATH.
 */

import { spawn } from "node:child_process";
import type { PlaybackChapter } from "@/lib/player/playback-chapters";

export type AsrSegment = { start: number; end: number; text: string };

/** Search a little earlier than the estimate. The old marks landed late. */
export const ASR_WINDOW_BEFORE_SEC = 25;
export const ASR_WINDOW_AFTER_SEC = 15;

export function asrWindow(estimate: number, fileSeconds: number): { start: number; end: number } {
  const start = Math.max(0, estimate - ASR_WINDOW_BEFORE_SEC);
  const end = Math.min(fileSeconds > 0 ? fileSeconds : estimate + ASR_WINDOW_AFTER_SEC, estimate + ASR_WINDOW_AFTER_SEC);
  return { start, end: Math.max(start + 1, end) };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Distinctive words of a title, enough to hear and short enough to fit one window. */
export function headingNeedle(title: string): string {
  const words = normalize(title).split(" ").filter(Boolean);
  if (words.length === 0) return "";
  return words.slice(0, 6).join(" ");
}

/**
 * Absolute second where the heading is spoken, or null when this window
 * does not contain it. `segments[].start` is relative to `windowStart`.
 */
export function snapToSpokenHeading(
  segments: AsrSegment[],
  title: string,
  windowStart: number
): number | null {
  const needle = headingNeedle(title);
  if (needle.length < 3) return null;
  let acc = "";
  for (const segment of segments) {
    const text = normalize(segment.text);
    if (!text) continue;
    const from = acc.length === 0 ? 0 : acc.length + 1;
    acc = acc ? `${acc} ${text}` : text;
    const at = acc.indexOf(needle);
    if (at >= 0 && at >= from - needle.length) {
      const spoken = windowStart + (Number.isFinite(segment.start) ? segment.start : 0);
      return Math.max(0, spoken);
    }
  }
  return null;
}

export function segmentsFromWhisperJson(payload: unknown): AsrSegment[] {
  const segments = (payload as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(segments)) return [];
  const out: AsrSegment[] = [];
  for (const row of segments) {
    if (!row || typeof row !== "object") continue;
    const start = (row as { start?: unknown }).start;
    const end = (row as { end?: unknown }).end;
    const text = (row as { text?: unknown }).text;
    if (typeof start !== "number" || typeof text !== "string") continue;
    out.push({
      start,
      end: typeof end === "number" ? end : start,
      text,
    });
  }
  return out;
}

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [bin], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** `faster-whisper` when it is installed, otherwise `whisper`. */
export async function resolveAsrCommand(): Promise<"faster-whisper" | "whisper" | null> {
  if (await which("faster-whisper")) return "faster-whisper";
  if (await which("whisper")) return "whisper";
  return null;
}

export async function applyAsrSnap(
  chapters: PlaybackChapter[],
  fileSeconds: number,
  transcribe: (start: number, end: number) => Promise<AsrSegment[] | null>
): Promise<PlaybackChapter[]> {
  const out: PlaybackChapter[] = [];
  for (const chapter of chapters) {
    const estimate = chapter.startSeconds;
    let startSeconds = estimate;
    if (typeof estimate === "number" && Number.isFinite(estimate)) {
      const window = asrWindow(estimate, fileSeconds);
      const segments = await transcribe(window.start, window.end);
      const snapped = segments ? snapToSpokenHeading(segments, chapter.title, window.start) : null;
      if (snapped != null) startSeconds = Math.round(snapped * 1000) / 1000;
    }
    const children = chapter.children?.length
      ? await applyAsrSnap(chapter.children, fileSeconds, transcribe)
      : undefined;
    out.push({
      ...chapter,
      ...(typeof startSeconds === "number" ? { startSeconds } : {}),
      ...(children && children.length > 0 ? { children } : {}),
    });
  }
  return out;
}
