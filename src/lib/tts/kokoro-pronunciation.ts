/**
 * Take-home cache suffix for the shared Kokoro pronunciation lexicon.
 * Mirrors `PRONUNCIATION_ID` in `scripts/sowell/pronounce.py`. Bump both
 * when an entry changes, so a cached preview or section is not replayed
 * with the old phonemes. The id is not a model pass and does not change
 * how long a section takes to render.
 */
export const KOKORO_PRONUNCIATION_ID = "lex1";
export const KOKORO_PRONUNCIATION_SUFFIX = `-g2p${KOKORO_PRONUNCIATION_ID}`;
export const KOKORO_PRONUNCIATION_HEADER = "x-kokoro-pronunciation";

/**
 * Null when this response was spoken with the lexicon the cache key names.
 * A missing or different header is an older container: storing it would
 * file the old phonemes under the new key.
 */
export function kokoroPronunciationMismatch(
  headers: { get(name: string): string | null }
): string | null {
  const spoken = headers.get(KOKORO_PRONUNCIATION_HEADER);
  if (spoken !== KOKORO_PRONUNCIATION_ID) {
    return `Kokoro endpoint pronunciation was ${spoken ?? "unknown"}, not ${KOKORO_PRONUNCIATION_ID}. The audio was not stored.`;
  }
  return null;
}
