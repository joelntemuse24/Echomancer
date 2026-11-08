import { describe, expect, it } from "vitest";
import {
  shouldPrewarmBeforeOutline,
  shouldPrewarmModalNarration,
} from "@/lib/tts/modal-narration-warm";

describe("shouldPrewarmBeforeOutline", () => {
  it("starts a restore for a new modal book that has no outline yet", () => {
    expect(
      shouldPrewarmBeforeOutline({
        modalVoice: true,
        clonePin: null,
        totalSections: 0,
        claimableCount: 0,
      })
    ).toBe(true);
  });

  it("does not start one for concat, saved raw, cache, or a fish pin", () => {
    expect(
      shouldPrewarmBeforeOutline({
        modalVoice: true,
        clonePin: "modal",
        totalSections: 293,
        claimableCount: 0,
      })
    ).toBe(false);
    expect(
      shouldPrewarmBeforeOutline({
        modalVoice: true,
        clonePin: "modal",
        totalSections: 4,
        claimableCount: 4,
      })
    ).toBe(false);
    expect(
      shouldPrewarmBeforeOutline({
        modalVoice: true,
        clonePin: "fish",
        totalSections: 0,
        claimableCount: 0,
      })
    ).toBe(false);
    expect(
      shouldPrewarmBeforeOutline({
        modalVoice: false,
        clonePin: null,
        totalSections: 0,
        claimableCount: 0,
      })
    ).toBe(false);
  });
});

describe("shouldPrewarmModalNarration", () => {
  it("starts a restore only for uncached modal renders", () => {
    expect(
      shouldPrewarmModalNarration({
        modalVoice: true,
        clonePin: "modal",
        uncachedRenderCount: 2,
      })
    ).toBe(true);
    expect(
      shouldPrewarmModalNarration({
        modalVoice: true,
        clonePin: "modal",
        uncachedRenderCount: 0,
      })
    ).toBe(false);
    expect(
      shouldPrewarmModalNarration({
        modalVoice: true,
        clonePin: "fish",
        uncachedRenderCount: 3,
      })
    ).toBe(false);
  });
});
