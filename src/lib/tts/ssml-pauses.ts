/**
 * Map Fish S2 pause tags to SSML `<break>` for Edge and Google TTS.
 *
 * Canonical cadence still comes from `toFishNarrationScript`. Those adapters
 * would speak `[break]` / `[long-break]` as words, so the last mile swaps
 * them for provider-native silence. Times stay light — same sparse/normal
 * *placement* as Fish, not a slower speaking rate.
 */

export const SSML_SHORT_BREAK_MS = 300;
export const SSML_LONG_BREAK_MS = 700;

export const SSML_SHORT_BREAK = `<break time="${SSML_SHORT_BREAK_MS}ms"/>`;
export const SSML_LONG_BREAK = `<break time="${SSML_LONG_BREAK_MS}ms"/>`;

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
  return script
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

export function scriptHasFishPauseTags(text: string): boolean {
  return /\[(?:long-)?break\]/i.test(text);
}
