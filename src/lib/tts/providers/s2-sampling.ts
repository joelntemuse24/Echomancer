/**
 * Sampling for the self-hosted S2-Pro clone path.
 *
 * Upstream defaults (0.7 / 0.7) flatten delivery: on a 70 s reference clip the
 * clone scored 6.6 semitones of pitch range against 13.3 in the source, with
 * phrase-level spread at 2.1 against 6.2. At 0.9 / 0.9 the same voice measured
 * 10.0 semitones and 6.1 spread — matching the source's phrasing without
 * changing the speaker's identity.
 *
 * Override with `MODAL_S2_SAMPLING` ("temperature,top_p"). Measured on one
 * speaker so far; re-check against a second voice before tuning further.
 */
export const MODAL_S2_SAMPLING =
  process.env.MODAL_S2_SAMPLING?.trim() || "0.9,0.9";
