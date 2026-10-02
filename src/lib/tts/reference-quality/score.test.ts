import { describe, expect, it } from "vitest";
import { REFERENCE_QUALITY_COPY, REFERENCE_QUALITY_THRESHOLDS as T } from "@/lib/tts/reference-quality/config";
import {
  evaluateReferenceQuality,
  keepRemaster,
  type ReferenceMetrics,
} from "@/lib/tts/reference-quality/score";

/** A clean TED-style reference, values from the Oct 2026 calibration. */
function clean(over: Partial<ReferenceMetrics> = {}): ReferenceMetrics {
  return {
    durationSec: 32,
    scoredSec: 32,
    speechSec: 22,
    dnsmosSig: 3.6,
    dnsmosBak: 3.5,
    dnsmosOvrl: 3.2,
    highBandDb: -18,
    pitchMedianHz: 140,
    pitchStdSt: 3.2,
    speakerPairMin: 0.85,
    ms: 900,
    ...over,
  };
}

const codes = (m: ReferenceMetrics) => evaluateReferenceQuality(m).issues.map((i) => i.code);

describe("evaluateReferenceQuality (calibrated cases)", () => {
  it("passes clean, noisy, music-bed, MP3 and short clips", () => {
    expect(evaluateReferenceQuality(clean()).verdict).toBe("pass");
    // treasure_n5 / brene_music / treasure_music / sinek / short8
    expect(evaluateReferenceQuality(clean({ dnsmosSig: 3.31, dnsmosBak: 1.93 })).verdict).toBe("pass");
    expect(evaluateReferenceQuality(clean({ dnsmosSig: 2.36, dnsmosBak: 1.42 })).verdict).toBe("pass");
    expect(evaluateReferenceQuality(clean({ highBandDb: -36 })).verdict).toBe("pass");
    expect(evaluateReferenceQuality(clean({ speechSec: 5.7, speakerPairMin: null })).verdict).toBe("pass");
  });

  it("fails echo (SIG 1.2-1.5) and flags it for a remaster", () => {
    const r = evaluateReferenceQuality(clean({ dnsmosSig: 1.17 }));
    expect(r.verdict).toBe("fail");
    expect(r.issues.map((i) => i.code)).toEqual(["echo"]);
    expect(r.remaster).toBe(true);
    expect(r.headline).toBe(REFERENCE_QUALITY_COPY.failHeadline);
    expect(r.body).toBe(REFERENCE_QUALITY_COPY.failBody);
  });

  it("fails a phone-band clip and never remasters it", () => {
    const r = evaluateReferenceQuality(clean({ highBandDb: -86, dnsmosSig: 1.5 }));
    expect(r.issues.map((i) => i.code)).toContain("bandlimited");
    expect(r.remaster).toBe(false);
  });

  it("fails two voices (pair 0.43) but not one voice (0.70+)", () => {
    expect(codes(clean({ speakerPairMin: 0.43 }))).toEqual(["two_speakers"]);
    expect(codes(clean({ speakerPairMin: 0.7 }))).toEqual([]);
  });

  it("notes flat delivery (1972 clip, 1.33 st) but never blocks on it", () => {
    const r = evaluateReferenceQuality(clean({ pitchStdSt: 1.33 }));
    expect(r.verdict).toBe("pass");
    expect(r.issues).toEqual([]);
    expect(r.notes.map((n) => n.code)).toEqual(["flat"]);
    expect(evaluateReferenceQuality(clean({ pitchStdSt: 1.33, speechSec: T.minSpeechSec - 1 })).notes).toEqual([]);
  });

  it("fails open when the models are not installed", () => {
    const r = evaluateReferenceQuality(clean({ dnsmosSig: null, dnsmosBak: null, dnsmosOvrl: null, speakerPairMin: null }));
    expect(r.verdict).toBe("pass");
    expect(r.remaster).toBe(false);
  });

  it("keeps every threshold in a sane order", () => {
    expect(T.remasterBelowSig).toBeLessThanOrEqual(T.remasterKeepSig);
    expect(T.echoSigFail).toBeLessThan(2.36); // lowest music-bed SIG that cloned fine
    expect(T.twoSpeakerPairMin).toBeLessThan(0.7);
    expect(T.twoSpeakerPairMin).toBeGreaterThan(0.43);
    expect(T.flatPitchStdSt).toBeGreaterThan(1.33);
    expect(T.flatPitchStdSt).toBeLessThan(2.75);
  });
});

describe("keepRemaster", () => {
  it("keeps a remaster that reaches the keep bar (echo 1.17 -> 2.97)", () => {
    expect(keepRemaster(clean({ dnsmosSig: 1.17 }), clean({ dnsmosSig: 2.97 }))).toBe(true);
    expect(keepRemaster(clean({ dnsmosSig: 1.52 }), clean({ dnsmosSig: 3.16 }))).toBe(true);
  });

  it("drops a remaster that did not lift SIG enough", () => {
    expect(keepRemaster(clean({ dnsmosSig: 1.17 }), clean({ dnsmosSig: 1.9 }))).toBe(false);
    expect(keepRemaster(clean({ dnsmosSig: 1.17 }), null)).toBe(false);
    expect(keepRemaster(clean({ dnsmosSig: 3.4 }), clean({ dnsmosSig: 3.0 }))).toBe(false);
  });
});
