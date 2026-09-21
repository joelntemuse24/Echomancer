/**
 * Map Fish S2 pause tags to provider-native silence for Edge and Google TTS.
 *
 * Canonical cadence still comes from `toFishNarrationScript`. Those adapters
 * would speak `[break]` / `[long-break]` as words, so the last mile swaps
 * them: Google gets SSML `<break>` (with a space before `/>`); Edge Read
 * Aloud rejects custom markup with websocket 1007, so it gets punctuation
 * breaths inside the stock speak/voice/prosody envelope. Emotion / tone
 * square brackets are stripped first so they are never spoken as words.
 * Times stay light — same sparse/normal *placement* as Fish, not a slower
 * speaking rate.
 */

import { stripNonPauseFishCues } from "@/lib/tts/fish-s2-cues";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";

/**
 * Google Cloud TTS `input.ssml` / `input.text` ceiling (UTF-8 bytes).
 * Exceeding this is HTTP 400 — Whole-book packing must stay under it.
 */
export const GOOGLE_TTS_INPUT_MAX_BYTES = 5000;
/**
 * Packer hard ceiling. Leaves headroom under {@link GOOGLE_TTS_INPUT_MAX_BYTES}
 * for last-mile pause mapping and XML escaping.
 */
export const GOOGLE_SSML_HARD_MAX_BYTES = 4900;

export const SSML_SHORT_BREAK_MS = 300;
export const SSML_LONG_BREAK_MS = 700;

export const SSML_SHORT_BREAK = `<break time="${SSML_SHORT_BREAK_MS}ms" />`;
export const SSML_LONG_BREAK = `<break time="${SSML_LONG_BREAK_MS}ms" />`;

/**
 * Edge Read Aloud rejects custom markup (`<break>`, extra tags) with websocket
 * 1007 "SSML is invalid". Microsoft only accepts the speak/voice/prosody
 * envelope it generates itself. Map Fish pause IR to punctuation the neural
 * will treat as a breath, not XML.
 */
export const EDGE_SHORT_PAUSE = " … ";
export const EDGE_LONG_PAUSE = "\n\n";

const SHORT_TAG = /^\[break\]$/i;
const LONG_TAG = /^\[long-break\]$/i;
const PAUSE_SPLIT_RE = /(\[(?:long-)?break\])/gi;

export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** Escape spoken text and replace Fish pause tags with SSML breaks. */
export function fishPausesToSsmlBody(script: string): string {
  return stripNonPauseFishCues(script)
    .split(PAUSE_SPLIT_RE)
    .map((part) => {
      if (SHORT_TAG.test(part)) return SSML_SHORT_BREAK;
      if (LONG_TAG.test(part)) return SSML_LONG_BREAK;
      return escapeSsmlText(part);
    })
    .join("");
}

export function wrapGoogleSsml(script: string): string {
  return `<speak>${fishPausesToSsmlBody(script)}</speak>`;
}

/** UTF-8 byte length of the SSML Google Cloud TTS actually receives. */
export function googleSsmlUtf8Bytes(script: string): number {
  return Buffer.byteLength(wrapGoogleSsml(script), "utf8");
}

/**
 * Whole-book Google payload size: synth-time pause IR → SSML wrap → UTF-8.
 * Pack against this, not raw speakable char count.
 */
export function googleSynthesisSsmlUtf8Bytes(sectionText: string): number {
  return googleSsmlUtf8Bytes(
    narrationScriptForSynthesis(sectionText, "google", { pauseStyle: "normal" })
  );
}

/** Escape spoken text and replace Fish pause tags with Edge-safe breaths. */
export function fishPausesToEdgeProsodyText(script: string): string {
  return stripNonPauseFishCues(script)
    .split(PAUSE_SPLIT_RE)
    .map((part) => {
      if (SHORT_TAG.test(part)) return EDGE_SHORT_PAUSE;
      if (LONG_TAG.test(part)) return EDGE_LONG_PAUSE;
      return escapeSsmlText(part);
    })
    .join("");
}

export function scriptHasFishPauseTags(text: string): boolean {
  return /\[(?:long-)?break\]/i.test(text);
}
