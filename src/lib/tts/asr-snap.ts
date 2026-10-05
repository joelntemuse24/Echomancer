/**
 * Optional spoken-heading snap. Off unless a re-chapter run passes
 * `--asr-snap` and `faster-whisper` or `whisper` is on PATH.
 */

import { spawn } from "node:child_process";
import type { PlaybackChapter } from "@/lib/player/playback-chapters";

export type AsrWord = { start: number; end: number; text: string };

export type AsrSegment = { start: number; end: number; text: string; words?: AsrWord[] };

/** Search a little earlier than the estimate. The old marks landed late. */
export const ASR_WINDOW_BEFORE_SEC = 25;
export const ASR_WINDOW_AFTER_SEC = 15;

/** Place the mark just before the spoken word, so the heading is not clipped. */
export const ASR_LEAD_SEC = 0.5;

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS_WORDS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const WORD_TO_NUMBER = new Map<string, number>();
NUMBER_WORDS.forEach((word, value) => WORD_TO_NUMBER.set(word, value));
TENS_WORDS.forEach((word, value) => {
  if (word) WORD_TO_NUMBER.set(word, value * 10);
});

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
  const words = canonicalWords(normalize(title));
  if (words.length === 0) return "";
  return words.slice(0, 6).join(" ");
}

/**
 * Number words and digits share one form, so "part four" matches "Part 4".
 * "twenty one" is one number when the words sit together.
 */
export function canonicalWords(text: string): string[] {
  const words = text.split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (/^\d+$/.test(word)) {
      out.push(String(Number(word)));
      continue;
    }
    const value = WORD_TO_NUMBER.get(word);
    const next = words[i + 1];
    const nextValue = next ? WORD_TO_NUMBER.get(next) : undefined;
    if (
      value != null &&
      value >= 20 &&
      value % 10 === 0 &&
      nextValue != null &&
      nextValue > 0 &&
      nextValue < 10
    ) {
      out.push(String(value + nextValue));
      i += 1;
      continue;
    }
    if (value != null && value < 20) {
      out.push(String(value));
      continue;
    }
    if (value != null && value % 10 === 0) {
      out.push(String(value));
      continue;
    }
    out.push(word);
  }
  return out;
}

type SpokenToken = { text: string; start: number };

function spokenTokens(segments: AsrSegment[]): SpokenToken[] {
  const tokens: SpokenToken[] = [];
  for (const segment of segments) {
    const start = Number.isFinite(segment.start) ? segment.start : 0;
    if (segment.words?.length) {
      for (const word of segment.words) {
        const pieces = canonicalWords(normalize(word.text));
        const at = Number.isFinite(word.start) ? word.start : start;
        for (const piece of pieces) tokens.push({ text: piece, start: at });
      }
      continue;
    }
    for (const piece of canonicalWords(normalize(segment.text))) {
      tokens.push({ text: piece, start });
    }
  }
  return tokens;
}

/**
 * Absolute second where the heading is spoken, or null when this window
 * does not contain it. Word timestamps win over the segment start. The mark
 * leads the word by {@link ASR_LEAD_SEC}. Times are relative to `windowStart`.
 */
export function snapToSpokenHeading(
  segments: AsrSegment[],
  title: string,
  windowStart: number
): number | null {
  const needle = headingNeedle(title).split(" ").filter(Boolean);
  if (needle.join(" ").length < 3) return null;
  const tokens = spokenTokens(segments);
  for (let i = 0; i <= tokens.length - needle.length; i++) {
    const matches = needle.every((word, offset) => tokens[i + offset]?.text === word);
    if (!matches) continue;
    const spoken = windowStart + tokens[i]!.start - ASR_LEAD_SEC;
    return Math.max(0, Math.round(spoken * 1000) / 1000);
  }
  return null;
}

function readWords(row: { words?: unknown }): AsrWord[] | undefined {
  if (!Array.isArray(row.words)) return undefined;
  const words: AsrWord[] = [];
  for (const word of row.words) {
    if (!word || typeof word !== "object") continue;
    const start = (word as { start?: unknown }).start;
    const end = (word as { end?: unknown }).end;
    const labeled = word as { word?: unknown; text?: unknown };
    const text = typeof labeled.word === "string" ? labeled.word : labeled.text;
    if (typeof start !== "number" || typeof text !== "string") continue;
    words.push({ start, end: typeof end === "number" ? end : start, text });
  }
  return words.length > 0 ? words : undefined;
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
    const words = readWords(row as { words?: unknown });
    out.push({
      start,
      end: typeof end === "number" ? end : start,
      text,
      ...(words ? { words } : {}),
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
