import type { VoiceAccent } from "@/lib/tts/voice-persona";

/**
 * Fixed one-liner for narrator previews.
 * Intentionally short (~1–2s of audio) so browsing voices stays snappy —
 * never pulled from the uploaded book.
 *
 * Keep this plain — do not embed "British accent" etc. in the spoken line.
 * Accent is steered via Gemini input direction / soft stylePrompt instead.
 * (Embedding accent claims + aggressive prompts returned empty Gemini audio.)
 */
export const PREVIEW_TEXT =
  "Hi — I'm an AI narrator on Echomancer. Here's how I sound.";

/** @deprecated Use PREVIEW_TEXT; accent is applied via synthesis direction. */
export function previewTextForAccent(
  _accent?: VoiceAccent | string | null
): string {
  return PREVIEW_TEXT;
}

/** Browser-safe MIME sniff for preview playback (no Node Buffer). */
export function sniffPreviewMime(
  bytes: ArrayBuffer,
  headerType?: string | null
): string {
  const header = (headerType || "").split(";")[0]?.trim() || "";
  if (header.startsWith("audio/")) return header;

  const u8 = new Uint8Array(bytes);
  if (u8.length >= 12) {
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...u8.slice(start, end));
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
    if (ascii(0, 4) === "OggS") return "audio/ogg";
  }
  if (u8.length >= 3 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
    return "audio/mpeg";
  }
  if (u8.length >= 2 && u8[0] === 0xff && (u8[1]! & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  return "audio/mpeg";
}

/** True when the buffer is only a silent/empty WAV header (or tinier). */
export function isEmptyOrSilentAudio(buf: Uint8Array | Buffer, minBytes = 256): boolean {
  if (!buf || buf.length < minBytes) return true;
  // Empty WAV: 44-byte header with data size 0
  if (
    buf.length <= 44 &&
    buf.length >= 12 &&
    String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!) === "RIFF"
  ) {
    return true;
  }
  return false;
}
