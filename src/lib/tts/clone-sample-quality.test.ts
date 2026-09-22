import { describe, expect, it } from "vitest";
import {
  CLONE_SAMPLE_QUALITY_COPY,
  evaluateCloneSampleQuality,
  formatCloneSampleQualityMessage,
  type CloneSampleMetrics,
} from "./clone-sample-quality";

/** Sep 2026 calibration — injected metrics, not live DSP. */
const PHONE_RAW: CloneSampleMetrics = {
  duration_s: 42,
  clip_frac: 0.0002,
  speech_frac: 0.58,
  speech_level_db: -22,
  rt60_est_s: 2.4,
  reverb_proxy: 0.62,
};

const PHONE_AFTER_CLEANERS: CloneSampleMetrics = {
  duration_s: 42,
  clip_frac: 0.0001,
  speech_frac: 0.6,
  speech_level_db: -18,
  rt60_est_s: 1.2,
  reverb_proxy: 0.48,
};

const WOLFE: CloneSampleMetrics = {
  duration_s: 38,
  clip_frac: 0,
  speech_frac: 0.64,
  speech_level_db: -20,
  rt60_est_s: 0.62,
  reverb_proxy: 0.21,
};

/** Over-cleaned studio: dry + high SNR must still pass. */
const STUDIO2_OVERCLEANED: CloneSampleMetrics = {
  duration_s: 28,
  clip_frac: 0,
  speech_frac: 0.71,
  speech_level_db: -14,
  rt60_est_s: 0.43,
  reverb_proxy: 0.12,
};

function usable(overrides: Partial<CloneSampleMetrics> = {}): CloneSampleMetrics {
  return { ...WOLFE, ...overrides };
}

describe("evaluateCloneSampleQuality (calibration)", () => {
  it("fails a raw phone sample with ~2.4s RT60 as too_reverberant", () => {
    const report = evaluateCloneSampleQuality(PHONE_RAW);
    expect(report.ok).toBe(false);
    expect(report.verdict).toBe("fail");
    expect(report.headline).toBe(CLONE_SAMPLE_QUALITY_COPY.failHeadline);
    expect(report.primary_message).toBe(CLONE_SAMPLE_QUALITY_COPY.failPrimary);
    expect(report.user_action).toBe(CLONE_SAMPLE_QUALITY_COPY.failPrimary);
    expect(report.fails.map((f) => f.code)).toContain("too_reverberant");
    expect(report.fails.some((f) => /re-record|room|mouth/i.test(f.detail))).toBe(
      true
    );
    expect(formatCloneSampleQualityMessage(report)).toContain(
      "isn't good enough to clone well"
    );
    expect(formatCloneSampleQualityMessage(report)).toContain(
      "re-record a fresh sample"
    );
  });

  it("still fails the same phone take after Adobe/Resemble-style cleaning (~1.2s RT60)", () => {
    const report = evaluateCloneSampleQuality(PHONE_AFTER_CLEANERS);
    expect(report.ok).toBe(false);
    expect(report.verdict).toBe("fail");
    expect(report.fails.map((f) => f.code)).toContain("too_reverberant");
    expect(report.headline).toMatch(/isn't good enough to clone well/i);
  });

  it("passes the Wolfe reference (~0.62s RT60)", () => {
    const report = evaluateCloneSampleQuality(WOLFE);
    expect(report.ok).toBe(true);
    expect(report.verdict).toBe("pass");
    expect(report.fails).toEqual([]);
  });

  it("passes over-cleaned studio2 (~0.43s RT60) and does not fail high SNR", () => {
    const report = evaluateCloneSampleQuality(STUDIO2_OVERCLEANED);
    expect(report.ok).toBe(true);
    expect(report.verdict).toBe("pass");
    expect(report.fails).toEqual([]);
  });
});

describe("evaluateCloneSampleQuality (thresholds)", () => {
  it("fails duration under 10s and over 180s", () => {
    expect(evaluateCloneSampleQuality(usable({ duration_s: 9.9 })).fails.map((f) => f.code)).toContain(
      "too_short"
    );
    expect(evaluateCloneSampleQuality(usable({ duration_s: 10 })).fails).toEqual([]);
    expect(evaluateCloneSampleQuality(usable({ duration_s: 180 })).fails).toEqual([]);
    expect(evaluateCloneSampleQuality(usable({ duration_s: 180.1 })).fails.map((f) => f.code)).toContain(
      "too_long"
    );
  });

  it("fails when clip_frac is greater than 0.001", () => {
    expect(evaluateCloneSampleQuality(usable({ clip_frac: 0.001 })).fails).toEqual([]);
    expect(
      evaluateCloneSampleQuality(usable({ clip_frac: 0.0011 })).fails.map((f) => f.code)
    ).toContain("clipped");
  });

  it("fails when speech_frac is under 0.25", () => {
    expect(evaluateCloneSampleQuality(usable({ speech_frac: 0.25 })).fails).toEqual([]);
    expect(
      evaluateCloneSampleQuality(usable({ speech_frac: 0.249 })).fails.map((f) => f.code)
    ).toContain("too_little_speech");
  });

  it("fails speech that is too quiet or too hot", () => {
    expect(evaluateCloneSampleQuality(usable({ speech_level_db: -45 })).fails).toEqual(
      []
    );
    expect(evaluateCloneSampleQuality(usable({ speech_level_db: -8 })).fails).toEqual(
      []
    );
    expect(
      evaluateCloneSampleQuality(usable({ speech_level_db: -45.1 })).fails.map(
        (f) => f.code
      )
    ).toContain("too_quiet");
    expect(
      evaluateCloneSampleQuality(usable({ speech_level_db: -7.9 })).fails.map(
        (f) => f.code
      )
    ).toContain("too_loud");
  });

  it("warns mild reverb between 0.75s and 0.95s RT60 without blocking", () => {
    const report = evaluateCloneSampleQuality(usable({ rt60_est_s: 0.76 }));
    expect(report.ok).toBe(true);
    expect(report.verdict).toBe("warn");
    expect(report.warns.map((w) => w.code)).toContain("mild_reverb");
    expect(report.fails).toEqual([]);
  });

  it("does not warn at exactly 0.75s RT60", () => {
    const report = evaluateCloneSampleQuality(usable({ rt60_est_s: 0.75 }));
    expect(report.verdict).toBe("pass");
    expect(report.warns).toEqual([]);
  });

  it("fails echo_in_speech when reverb_proxy is high and RT60 is unknown or > 0.75s", () => {
    const unknown = evaluateCloneSampleQuality(
      usable({ rt60_est_s: null, reverb_proxy: 0.41 })
    );
    expect(unknown.fails.map((f) => f.code)).toContain("echo_in_speech");

    const wet = evaluateCloneSampleQuality(
      usable({ rt60_est_s: 0.76, reverb_proxy: 0.41 })
    );
    expect(wet.fails.map((f) => f.code)).toContain("echo_in_speech");
  });

  it("does not fail echo_in_speech when RT60 is known and dry even if proxy is high", () => {
    const report = evaluateCloneSampleQuality(
      usable({ rt60_est_s: 0.62, reverb_proxy: 0.5 })
    );
    expect(report.fails.map((f) => f.code)).not.toContain("echo_in_speech");
    expect(report.verdict).toBe("pass");
  });

  it("does not use SNR as a pass/fail input", () => {
    const withSnr = evaluateCloneSampleQuality({
      ...STUDIO2_OVERCLEANED,
      snr_db: 40,
    } as CloneSampleMetrics & { snr_db: number });
    expect(withSnr.verdict).toBe("pass");
    expect(withSnr.fails).toEqual([]);
  });
});
