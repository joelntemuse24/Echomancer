import { describe, expect, it } from "vitest";
import { resolveVoiceContinue } from "./voice-continue";

const ready = {
  path: "clone" as const,
  hasPendingSample: false,
  qualityVerdict: null,
  qualityChecking: false,
  busy: false,
  hasSelectedVoice: true,
  hasBook: true,
};

describe("resolveVoiceContinue", () => {
  it("does not start the auto-selected clone when a new sample is pending", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        hasPendingSample: true,
        qualityVerdict: "pass",
      })
    ).toEqual({ type: "clone-and-start" });
  });

  it("allows a warned sample to clone and start the book", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        hasPendingSample: true,
        qualityVerdict: "warn",
      })
    ).toEqual({ type: "clone-and-start" });
  });

  it("blocks a failed sample instead of falling back to the selected clone", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        hasPendingSample: true,
        qualityVerdict: "fail",
      })
    ).toEqual({ type: "blocked", reason: "quality-fail" });
  });

  it("waits for the quality check before either clone or the old voice", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        hasPendingSample: true,
        qualityChecking: true,
        qualityVerdict: null,
      })
    ).toEqual({ type: "blocked", reason: "quality-checking" });
  });

  it("clones without starting a job when no book is in the URL", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        hasPendingSample: true,
        hasBook: false,
        qualityVerdict: "pass",
      })
    ).toEqual({ type: "clone-only" });
  });

  it("starts the selected voice when no sample is pending", () => {
    expect(resolveVoiceContinue(ready)).toEqual({ type: "start-selected" });
    expect(
      resolveVoiceContinue({
        ...ready,
        path: "standard",
        hasSelectedVoice: true,
      })
    ).toEqual({ type: "start-selected" });
  });

  it("does not treat a pending sample on the standard path as a clone", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        path: "standard",
        hasPendingSample: true,
        qualityVerdict: "pass",
      })
    ).toEqual({ type: "start-selected" });
  });

  it("stays blocked while a clone or job is already running", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        hasPendingSample: true,
        qualityVerdict: "pass",
        busy: true,
      })
    ).toEqual({ type: "blocked", reason: "busy" });
  });

  it("does nothing when clone has no sample and no selected voice", () => {
    expect(
      resolveVoiceContinue({
        ...ready,
        hasSelectedVoice: false,
        hasBook: false,
      })
    ).toEqual({ type: "blocked", reason: "nothing" });
  });
});
