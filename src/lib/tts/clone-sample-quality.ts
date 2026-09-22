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
} as const;

export const CLONE_SAMPLE_QUALITY_COPY = {
  failHeadline: "This sample isn't good enough to clone well.",
  failPrimary:
    "Please re-record a fresh sample (don't try to 'fix' this one with cleaners).",
  reverbDetail:
    "Record in a quieter, less echoey room with the phone close to your mouth.",
  tip: "Good clones need a dry room and a phone close to your mouth. Cleaning tools won't rescue echo.",
  warnHeadline: "This sample might sound a bit echoey.",
  warnPrimary:
    "You can still clone it. A closer recording in a drier room will sound more like you.",
  passHeadline: "This sample looks usable.",
  tooShort: "Use 10 seconds to 3 minutes of continuous speech.",
  tooLong: "Keep the sample to 3 minutes or less.",
  clipped: "The recording is clipping. Re-record a bit quieter, closer to the mic.",
  tooLittleSpeech: "We didn't hear enough speech. Read a page aloud in a quiet room.",
  tooQuiet: "The voice is too quiet. Hold the phone closer and speak at a normal level.",
  tooLoud: "The voice is too loud and may distort. Back off a little and re-record.",
  tooReverberant:
    "There's too much room echo. Record in a quieter, less echoey room with the phone close to your mouth.",
  echoInSpeech:
    "Echo is sitting on the voice itself. Record in a quieter, less echoey room with the phone close to your mouth.",
  mildReverb:
    "A little room sound is coming through. You can proceed, or re-record closer in a drier room.",
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
  | "mild_reverb";

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
  if (rt60 != null && rt60 > T.rt60FailS) {
    fails.push(issue("too_reverberant", COPY.tooReverberant));
  } else if (rt60 != null && rt60 > T.rt60WarnS) {
    warns.push(issue("mild_reverb", COPY.mildReverb));
  }

  const rt60UnknownOrWet = rt60 == null || rt60 > T.rt60WarnS;
  if (metrics.reverb_proxy > T.reverbProxyFail && rt60UnknownOrWet) {
    fails.push(issue("echo_in_speech", COPY.echoInSpeech));
  }

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
    return {
      ok: true,
      verdict: "warn",
      headline: COPY.warnHeadline,
      primary_message: COPY.warnPrimary,
      user_action: COPY.warnPrimary,
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
