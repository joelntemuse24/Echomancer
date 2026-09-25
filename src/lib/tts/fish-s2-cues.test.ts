import { describe, expect, it } from "vitest";
import {
  FISH_S2_ALLOWED_CUES,
  isAllowedFishS2Cue,
  proseFingerprint,
  stripFishS2Cues,
  stripNonPauseFishCues,
} from "./fish-s2-cues";

describe("published Fish cue table", () => {
  it("recognizes official pause, emotion, tone, and effect tags", () => {
    expect(isAllowedFishS2Cue("break")).toBe(true);
    expect(isAllowedFishS2Cue("long-break")).toBe(true);
    expect(isAllowedFishS2Cue("whispering")).toBe(true);
    expect(isAllowedFishS2Cue("slightly sad")).toBe(true);
    expect(isAllowedFishS2Cue("very excited")).toBe(true);
    expect(isAllowedFishS2Cue("extremely angry")).toBe(true);
    expect(isAllowedFishS2Cue("soft tone")).toBe(true);
    expect(isAllowedFishS2Cue("in a hurry tone")).toBe(true);
    expect(FISH_S2_ALLOWED_CUES.has("happy")).toBe(true);
    expect(FISH_S2_ALLOWED_CUES.has("sighing")).toBe(true);
  });

  it("does not treat free-form attitudes as published-table members", () => {
    expect(isAllowedFishS2Cue("pause")).toBe(false);
    expect(isAllowedFishS2Cue("matter-of-fact")).toBe(false);
    expect(isAllowedFishS2Cue("cynical")).toBe(false);
    expect(isAllowedFishS2Cue("conversational seminar tone")).toBe(false);
    expect(isAllowedFishS2Cue("warm and happy")).toBe(false);
    expect(isAllowedFishS2Cue("")).toBe(false);
  });
});

describe("stripFishS2Cues / fingerprint", () => {
  it("fingerprint ignores free-form cues and whitespace", () => {
    expect(proseFingerprint("[cynical] Hello   world.")).toBe(
      proseFingerprint("Hello world.")
    );
    expect(stripFishS2Cues("[long-break] Hello [cynical] [break] world.")).toMatch(
      /Hello\s+world\./
    );
    expect(stripFishS2Cues("[matter-of-fact] Hello.")).not.toMatch(/\[/);
    const stripped = stripNonPauseFishCues(
      "[calm] Hello [break] world [matter-of-fact]."
    );
    expect(stripped).toContain("Hello [break] world");
    expect(stripped).not.toMatch(/\[calm\]|\[matter-of-fact\]/);
  });
});
