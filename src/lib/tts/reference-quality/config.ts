/**
 * Clone reference quality gate: every threshold and every user-facing line
 * in one place.
 *
 * Calibrated Oct 2026 on 21 references (real LibriVox, TED and the 1972 AP
 * Kissinger clip, plus clean clips degraded with noise, music, phone band,
 * MP3 32k, reverb, an 8 s cut and a two-speaker mix). Each was cloned on
 * Fish and the output scored for DNSMOS, similarity to the clean speaker,
 * Whisper WER, squeaks and pitch spread. See docs/clone-quality-gate.md.
 *
 * What predicted a bad clone:
 *   - echo / distortion: DNSMOS SIG of the reference (reverb refs 1.2 and 1.5,
 *     every other ref 2.4 or more). Output OVRL fell to 1.7-1.8.
 *   - phone band: no energy above 4 kHz. Output copied the muffled sound and
 *     lost likeness (0.78-0.80 against 0.86-0.93 clean).
 *   - two voices: Fish cloned one of them (0.56 likeness to the other).
 * Soft note only: flat delivery (the 1972 clip, pitch spread 1.3 st, everyone
 * else 2.7+) gave a flat book (1.1 st), but that is the speaker's own voice.
 * Noise, music beds, MP3 32k and an 8 s clip did not: Fish's own cleanup
 * handled them, and extra denoise cut likeness by 0.05-0.10.
 */

export const REFERENCE_QUALITY_THRESHOLDS = {
  /** DNSMOS P.835 SIG below this: echo or distortion the clone will copy. */
  echoSigFail: 2.0,
  /**
   * Echo clips get one DeepFilterNet pass when the user continues anyway.
   * On the two echo refs it lifted Fish output OVRL 1.79->2.80 and
   * 1.67->3.21, WER 6.0%->1.2% and 3.6%->4.8%, likeness unchanged
   * (-0.008 / -0.005). On music beds, noise, phone band and the 1972 clip it
   * cut likeness by 0.05-0.10, so nothing else is remastered.
   */
  remasterBelowSig: 2.0,
  /**
   * The remastered take is kept only if its SIG reaches this (out of the
   * echo range, level with a normal clip). The echo refs went 1.17->2.97 and
   * 1.52->3.16 on the worker.
   */
  remasterKeepSig: 2.5,
  /** Speech energy 4-8 kHz vs 0.3-4 kHz, dB. Phone band reads about -85. */
  bandlimitedHfDb: -45,
  /**
   * Pitch spread under this (semitones) gives a flat-sounding book. Soft note
   * only (logged, never blocks): it is the speaker's real voice, and pitch
   * stretching was tried and rejected.
   */
  flatPitchStdSt: 2.0,
  /** Lowest likeness between any two 4 s windows. Two speakers read lower. */
  twoSpeakerPairMin: 0.55,
  /** Too little speech to judge pitch or voices. */
  minSpeechSec: 4,
  /** Score at most this much audio (the start of the clip). */
  maxScoreSec: 60,
} as const;

export const REFERENCE_QUALITY_COPY = {
  failHeadline: "This clip may not clone well.",
  failBody: "Try a cleaner clip.",
  echo: "Echo on the voice.",
  bandlimited: "Sounds like a phone line.",
  twoSpeakers: "More than one voice.",
  flat: "Very flat delivery.",
  chooseAnother: "Choose another clip",
  continueAnyway: "Continue anyway",
} as const;

/** Blocking issues: the user sees the warning. */
export type ReferenceIssueCode = "echo" | "bandlimited" | "two_speakers";
/** Soft notes: logged, never shown as a warning. */
export type ReferenceNoteCode = "flat";

/**
 * No silent "borderline + remaster" tier: in testing every clip either cloned
 * fine as is (remaster only hurt it) or was bad enough to warn on even after
 * a remaster. See docs/clone-quality-gate.md.
 */
export type ReferenceVerdict = "pass" | "fail";
