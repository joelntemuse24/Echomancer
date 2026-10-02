/**
 * Deterministic clone-sample quality gate.
 *
 * Thresholds calibrated Sep 2026 against real refs:
 *   phone raw ~2.4s RT60 → fail
 *   same after Adobe/Resemble ~1.2s → still fail
 *   Wolfe ~0.62s → pass
 *   over-cleaned studio2 ~0.43s → pass (do not fail high SNR)
 *
 * SNR / gap-floor silence is never a hard pass/fail — it misreads dry rooms
 * and over-cleaned takes. Reverb and speech occupancy are the bar.
 *
 * `evaluateCloneSampleQuality` is pure: tests inject precomputed metrics.
 * PCM measurement lives in `clone-sample-quality-metrics.ts`.
 */

export const CLONE_SAMPLE_QUALITY_THRESHOLDS = {
  minDurationS: 10,
  maxDurationS: 180,
  clipFracFail: 0.001,
  speechFracFail: 0.25,
  speechLevelMinDb: -45,
  speechLevelMaxDb: -8,
  rt60FailS: 0.95,
  rt60WarnS: 0.75,
  reverbProxyFail: 0.4,
  /** Warn when 95% of the energy sits below this frequency. */
  hfRolloffHz: 4_000,
  /** Warn when speech is less than this far above the noise bed. */
  speechBgGapDb: 25,
} as const;

export const CLONE_SAMPLE_QUALITY_COPY = {
  failHeadline: "Too much echo to clone.",
  failPrimary: "Record again. Cleaning it up won't help.",
  reverbDetail: "Record closer and quieter.",
  tip: "Record closer and quieter. Cleaning won't rescue echo.",
  warnHeadline: "A bit echoey.",
  warnPrimary: "You can still clone it.",
  passHeadline: "This sample looks usable.",
  tooShort: "Use 10 seconds to 3 minutes of speech.",
  tooLong: "Keep it under 3 minutes.",
  clipped: "Too loud. Record quieter.",
  tooLittleSpeech: "Not enough speech. Read a page.",
  tooQuiet: "Too quiet. Hold the phone closer.",
  tooLoud: "Too loud. Step back and record again.",
  tooReverberant: "Too much room echo.",
  echoInSpeech: "Echo is on the voice.",
  mildReverb: "A little room sound.",
  archiveHeadline: "Muffled or noisy.",
  archiveBody: "You can still use it.",
} as const;

export type CloneSampleVerdict = "pass" | "warn" | "fail";

export type CloneSampleIssueCode =
  | "too_short"
  | "too_long"
  | "clipped"
  | "too_little_speech"
  | "too_quiet"
  | "too_loud"
  | "too_reverberant"
  | "echo_in_speech"
  | "mild_reverb"
  | "muffled"
  | "noisy";

export type CloneSampleIssue = {
  code: CloneSampleIssueCode;
  detail: string;
};

export type CloneSampleMetrics = {
  duration_s: number;
  clip_frac: number;
  speech_frac: number;
  speech_level_db: number;
  rt60_est_s: number | null;
  reverb_proxy: number;
  /** Hertz under which 95% of the energy sits. Null on a clip too short to measure. */
  energy_hz_95?: number | null;
  /** Speech level minus the noise bed, in dB. */
  speech_bg_gap_db?: number | null;
};

export type CloneSampleQualityReport = {
  ok: boolean;
  verdict: CloneSampleVerdict;
  headline: string;
  primary_message: string;
  user_action: string;
  fails: CloneSampleIssue[];
  warns: CloneSampleIssue[];
  metrics: CloneSampleMetrics;
};

const T = CLONE_SAMPLE_QUALITY_THRESHOLDS;
const COPY = CLONE_SAMPLE_QUALITY_COPY;

function issue(code: CloneSampleIssueCode, detail: string): CloneSampleIssue {
  return { code, detail };
}

export function evaluateCloneSampleQuality(
  metrics: CloneSampleMetrics
): CloneSampleQualityReport {
  const fails: CloneSampleIssue[] = [];
  const warns: CloneSampleIssue[] = [];

  if (metrics.duration_s < T.minDurationS) {
    fails.push(issue("too_short", COPY.tooShort));
  } else if (metrics.duration_s > T.maxDurationS) {
    fails.push(issue("too_long", COPY.tooLong));
  }

  if (metrics.clip_frac > T.clipFracFail) {
    fails.push(issue("clipped", COPY.clipped));
  }

  if (metrics.speech_frac < T.speechFracFail) {
    fails.push(issue("too_little_speech", COPY.tooLittleSpeech));
  }

  if (metrics.speech_level_db < T.speechLevelMinDb) {
    fails.push(issue("too_quiet", COPY.tooQuiet));
  } else if (metrics.speech_level_db > T.speechLevelMaxDb) {
    fails.push(issue("too_loud", COPY.tooLoud));
  }

  const rt60 = metrics.rt60_est_s;
  // A steady noise bed never decays, so the reverb estimate reads it as a
  // long tail. That is the noisy warning, not a room the person must re-record.
  const noisyBed =
    typeof metrics.speech_bg_gap_db === "number" &&
    metrics.speech_bg_gap_db < T.speechBgGapDb;
  if (!noisyBed && rt60 != null && rt60 > T.rt60FailS) {
    fails.push(issue("too_reverberant", COPY.tooReverberant));
  } else if (!noisyBed && rt60 != null && rt60 > T.rt60WarnS) {
    warns.push(issue("mild_reverb", COPY.mildReverb));
  }

  const rt60UnknownOrWet = rt60 == null || rt60 > T.rt60WarnS;
  if (!noisyBed && metrics.reverb_proxy > T.reverbProxyFail && rt60UnknownOrWet) {
    fails.push(issue("echo_in_speech", COPY.echoInSpeech));
  }

  // The "muffled" (energy_hz_95 < 4 kHz) and "noisy" warnings were removed in
  // Oct 2026: they fired on 17 of 20 test clips, clean LibriVox and TED
  // included, and did not predict a worse clone. The worker reference gate
  // (src/lib/tts/reference-quality) now judges phone band, echo, two voices
  // and flat delivery from measured clone results.

  if (fails.length > 0) {
    return {
      ok: false,
      verdict: "fail",
      headline: COPY.failHeadline,
      primary_message: COPY.failPrimary,
      user_action: COPY.failPrimary,
      fails,
      warns,
      metrics,
    };
  }

  if (warns.length > 0) {
    const headline = COPY.warnHeadline;
    const primary = COPY.warnPrimary;
    return {
      ok: true,
      verdict: "warn",
      headline,
      primary_message: primary,
      user_action: primary,
      fails,
      warns,
      metrics,
    };
  }

  return {
    ok: true,
    verdict: "pass",
    headline: COPY.passHeadline,
    primary_message: "",
    user_action: "",
    fails,
    warns,
    metrics,
  };
}

export function formatCloneSampleQualityMessage(
  report: Pick<CloneSampleQualityReport, "headline" | "primary_message">
): string {
  return [report.headline, report.primary_message].filter(Boolean).join(" ");
}
