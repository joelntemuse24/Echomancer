/**
 * Score a clone reference and turn the numbers into pass / fail (+ soft notes).
 * `evaluateReferenceQuality` is pure so the thresholds are unit-tested.
 */

import {
  REFERENCE_QUALITY_COPY as COPY,
  REFERENCE_QUALITY_THRESHOLDS as T,
  type ReferenceIssueCode,
  type ReferenceNoteCode,
  type ReferenceVerdict,
} from "@/lib/tts/reference-quality/config";
import { REF_RATE, highBandDb, speechMask, speechSeconds } from "@/lib/tts/reference-quality/dsp";
import { dnsmos, speakerPairMin } from "@/lib/tts/reference-quality/models";
import { estimatePitchProfile } from "@/lib/tts/squeak-guard";

export type ReferenceMetrics = {
  durationSec: number;
  scoredSec: number;
  speechSec: number;
  /** DNSMOS P.835; null when the model runtime is not installed. */
  dnsmosSig: number | null;
  dnsmosBak: number | null;
  dnsmosOvrl: number | null;
  highBandDb: number;
  pitchMedianHz: number | null;
  pitchStdSt: number | null;
  speakerPairMin: number | null;
  ms: number;
};

export type ReferenceIssue = { code: ReferenceIssueCode; detail: string };
export type ReferenceNote = { code: ReferenceNoteCode; detail: string };

export type ReferenceQualityReport = {
  verdict: ReferenceVerdict;
  headline: string;
  body: string;
  issues: ReferenceIssue[];
  /** Soft notes (flat delivery): logged only, never block. */
  notes: ReferenceNote[];
  /** Echo: run one remaster pass if the user continues anyway. */
  remaster: boolean;
  metrics: ReferenceMetrics;
};

const DETAIL: Record<ReferenceIssueCode, string> = {
  echo: COPY.echo,
  bandlimited: COPY.bandlimited,
  two_speakers: COPY.twoSpeakers,
};

export function evaluateReferenceQuality(m: ReferenceMetrics): ReferenceQualityReport {
  const codes: ReferenceIssueCode[] = [];
  const enoughSpeech = m.speechSec >= T.minSpeechSec;
  if (m.dnsmosSig != null && m.dnsmosSig < T.echoSigFail) codes.push("echo");
  if (enoughSpeech && m.highBandDb < T.bandlimitedHfDb) codes.push("bandlimited");
  if (m.speakerPairMin != null && m.speakerPairMin < T.twoSpeakerPairMin) codes.push("two_speakers");
  const notes: ReferenceNote[] =
    enoughSpeech && m.pitchStdSt != null && m.pitchStdSt < T.flatPitchStdSt
      ? [{ code: "flat", detail: COPY.flat }]
      : [];
  const remaster =
    m.dnsmosSig != null && m.dnsmosSig < T.remasterBelowSig && !codes.includes("bandlimited");
  const issues = codes.map((code) => ({ code, detail: DETAIL[code] }));
  const verdict: ReferenceVerdict = issues.length ? "fail" : "pass";
  return {
    verdict,
    headline: verdict === "fail" ? COPY.failHeadline : "",
    body: verdict === "fail" ? COPY.failBody : "",
    issues,
    notes,
    remaster,
    metrics: m,
  };
}

/**
 * After a remaster pass: clone from the cleaned take only if its SIG reached
 * the keep bar and actually rose. The verdict does not change: the user has
 * already seen the warning and chose to continue.
 */
export function keepRemaster(original: ReferenceMetrics, remastered: ReferenceMetrics | null): boolean {
  const before = original.dnsmosSig;
  const after = remastered?.dnsmosSig;
  return after != null && after >= T.remasterKeepSig && (before == null || after > before);
}

/** Pitch spread and DNSMOS settle within the first half minute. */
const PITCH_SEC = 30;

/** Measure 16 kHz mono PCM (the first maxScoreSec of it). */
export async function measureReference(pcm: Float32Array): Promise<ReferenceMetrics> {
  const started = Date.now();
  const durationSec = pcm.length / REF_RATE;
  const x = pcm.subarray(0, Math.min(pcm.length, Math.round(T.maxScoreSec * REF_RATE)));
  const mask = speechMask(x);
  // DNSMOS runs on onnxruntime's own threads; let it start before the JS work.
  const mosP = dnsmos(x.subarray(0, Math.min(x.length, Math.round(PITCH_SEC * REF_RATE)))).catch(() => null);
  await new Promise((r) => setImmediate(r));
  const hf = highBandDb(x, mask);
  const pitch = estimatePitchProfile(x.subarray(0, Math.min(x.length, Math.round(PITCH_SEC * REF_RATE))), REF_RATE, {
    hopSec: 0.04,
  });
  const pair = await speakerPairMin(x, mask).catch(() => null);
  const mos = await mosP;
  return {
    durationSec,
    scoredSec: x.length / REF_RATE,
    speechSec: speechSeconds(mask),
    dnsmosSig: mos?.sig ?? null,
    dnsmosBak: mos?.bak ?? null,
    dnsmosOvrl: mos?.ovrl ?? null,
    highBandDb: hf,
    pitchMedianHz: pitch?.medianHz ?? null,
    pitchStdSt: pitch?.stdSemitones ?? null,
    speakerPairMin: pair,
    ms: Date.now() - started,
  };
}
