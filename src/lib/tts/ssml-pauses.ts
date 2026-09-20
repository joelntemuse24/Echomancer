/**
 * Map Fish S2 pause tags to provider-native silence for Edge and Google TTS.
 *
 * Canonical cadence still comes from `toFishNarrationScript`. Those adapters
 * would speak `[break]` / `[long-break]` as words, so the last mile swaps
 * them: Google gets SSML `<break>` (with a space before `/>`); Edge Read
 * Aloud rejects custom markup with websocket 1007, so it gets punctuation
 * breaths inside the stock speak/voice/prosody envelope. Times stay light —
 * same sparse/normal *placement* as Fish, not a slower speaking rate.
 */

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

/** Escape spoken text and replace Fish pause tags with Edge-safe breaths. */
export function fishPausesToEdgeProsodyText(script: string): string {
  return script
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
