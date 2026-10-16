/**
 * Server half of the live read-along clock: plan the text range of each
 * synthesis window and measure the audio a window actually delivered.
 * See `@/lib/player/stream-clock` for how the browser uses the result.
 */

import { mp3DurationSeconds } from "@/lib/tts/mp3-duration";
import { PCM_DEFAULTS } from "@/lib/tts/pcm-wav";
import {
  deliveryUserInputFromUnknown,
  resolveDeliverySettings,
} from "@/lib/tts/delivery-settings";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import {
  STREAM_CONN_PATTERN,
  type StreamTimelineWindow,
} from "@/lib/player/stream-clock";

export function parseStreamConn(raw: string | null | undefined): string | null {
  return raw && STREAM_CONN_PATTERN.test(raw) ? raw : null;
}

/**
 * Absolute text range of each window. Windows are trimmed slices of `slice`
 * (which begins at `base`), so each is located by search instead of by
 * summing lengths.
 */
export function planStreamWindows(
  slice: string,
  windows: string[],
  base: number
): StreamTimelineWindow[] {
  let from = 0;
  return windows.map((window) => {
    const found = slice.indexOf(window, from);
    const start = found >= 0 ? found : from;
    from = start + window.length;
    return { start: base + start, end: base + from, seconds: null };
  });
}

/** Audio length of one delivered window, or null when it cannot be measured. */
export function measureWindowSeconds(
  chunks: Uint8Array[],
  format: { pcm: boolean; sampleRate?: number }
): number | null {
  const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (bytes === 0) return null;
  if (format.pcm) {
    const rate = format.sampleRate ?? PCM_DEFAULTS.sampleRate;
    const bytesPerSecond =
      rate * PCM_DEFAULTS.numChannels * (PCM_DEFAULTS.bitDepth / 8);
    return bytes / bytesPerSecond;
  }
  const seconds = mp3DurationSeconds(Buffer.concat(chunks));
  return seconds && seconds > 0 ? seconds : null;
}

/**
 * The text a stream narrates. `stream_cursor` and the timeline windows index
 * into it, so the stream session and the transcript route both build it here.
 */
export function streamSpeakableText(rawText: string, ttsOptions: unknown): string {
  const delivery = resolveDeliverySettings(
    rawText,
    deliveryUserInputFromUnknown(ttsOptions)
  );
  return toSpeakableText(rawText, {
    normalizeTitles: delivery.normalizeTitles,
  }).trim();
}
