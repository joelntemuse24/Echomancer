/**
 * Take-home cache suffix for the shared Kokoro pronunciation lexicon.
 * Mirrors `PRONUNCIATION_ID` in `scripts/sowell/pronounce.py`. Bump both
 * when an entry changes, so a cached preview or section is not replayed
 * with the old phonemes. The id is not a model pass and does not change
 * how long a section takes to render.
 */
export const KOKORO_PRONUNCIATION_ID = "lex1";
export const KOKORO_PRONUNCIATION_SUFFIX = `-g2p${KOKORO_PRONUNCIATION_ID}`;
