/**
 * Voice ids that the shared Modal CPU Kokoro app serves.
 *
 * Client-safe: no Node imports, no environment reads. The picker, the
 * capacity warm, and the worker all agree on this list instead of repeating
 * string literals in each place.
 */

/** Drew — the app default. Fine-tuned Kokoro-82M with its own kmodel. */
export const DREW_VOICE_ID = "drew";
/**
 * Walter — the Kokoro-82M voice pack. The id is `sowell` because stored
 * books and picks already name it; only the listed name changed.
 */
export const WALTER_VOICE_ID = "sowell";
/** George — stock Kokoro `bm_george`. */
export const KOKORO_GEORGE_VOICE_ID = "george";

export const KOKORO_CPU_VOICE_IDS = [
  DREW_VOICE_ID,
  WALTER_VOICE_ID,
  KOKORO_GEORGE_VOICE_ID,
] as const;

export type KokoroCpuVoiceId = (typeof KOKORO_CPU_VOICE_IDS)[number];

/** True when this catalog id is served by the shared Kokoro CPU app. */
export function isKokoroCpuVoiceId(id?: string | null): boolean {
  return Boolean(
    id && (KOKORO_CPU_VOICE_IDS as readonly string[]).includes(id)
  );
}
