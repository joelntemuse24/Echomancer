import { describe, expect, it } from "vitest";
import {
  FISH_S2_ALLOWED_CUES,
  isAllowedFishS2Cue,
  proseFingerprint,
  sanitizeFishS2TaggedText,
  stripFishS2Cues,
} from "./fish-s2-cues";

const PROSE = [
  'She whispered softly, "Stay close."',
  "He sighed and looked away across the dark water.",
].join(" ");

describe("Fish S2 cue allowlist", () => {
  it("accepts official pause, emotion, tone, and delivery tags", () => {
    expect(isAllowedFishS2Cue("break")).toBe(true);
    expect(isAllowedFishS2Cue("long-break")).toBe(true);
    expect(isAllowedFishS2Cue("whispering")).toBe(true);
    expect(isAllowedFishS2Cue("slightly sad")).toBe(true);
    expect(isAllowedFishS2Cue("very excited")).toBe(true);
    expect(isAllowedFishS2Cue("extremely angry")).toBe(true);
    expect(isAllowedFishS2Cue("soft tone")).toBe(true);
    expect(isAllowedFishS2Cue("in a hurry tone")).toBe(true);
    expect(isAllowedFishS2Cue("conversational seminar tone")).toBe(true);
    expect(FISH_S2_ALLOWED_CUES.has("happy")).toBe(true);
    expect(FISH_S2_ALLOWED_CUES.has("sighing")).toBe(true);
  });

  it("rejects unknown, S1 paren-style, and free-form celebrity/style tags", () => {
    expect(isAllowedFishS2Cue("pause")).toBe(false);
    expect(isAllowedFishS2Cue("obama impression")).toBe(false);
    expect(isAllowedFishS2Cue("like morgan freeman")).toBe(false);
    expect(isAllowedFishS2Cue("explicit")).toBe(false);
    expect(isAllowedFishS2Cue("warm and happy")).toBe(false);
    expect(isAllowedFishS2Cue("")).toBe(false);
  });
});

describe("sanitizeFishS2TaggedText", () => {
  it("keeps allowlisted tags when the prose is unchanged", () => {
    const tagged = `[whispering] She whispered softly, "Stay close." [sighing] He sighed and looked away across the dark water.`;
    const out = sanitizeFishS2TaggedText(PROSE, tagged);
    expect(out).toContain("[whispering]");
    expect(out).toContain("[sighing]");
    expect(proseFingerprint(out)).toBe(proseFingerprint(PROSE));
  });

  it("strips unknown square-bracket tags and keeps the original words", () => {
    const tagged = `[mystery] ${PROSE} [obama impression] extra?`;
    const out = sanitizeFishS2TaggedText(PROSE, `[calm] ${PROSE} [totally-made-up]`);
    expect(out).toContain("[calm]");
    expect(out).not.toContain("totally-made-up");
    expect(out).not.toMatch(/\[mystery\]|\[obama/);
    expect(proseFingerprint(out)).toBe(proseFingerprint(PROSE));
    expect(sanitizeFishS2TaggedText(PROSE, tagged)).toBe(PROSE);
  });

  it("rejects a rewrite and returns the original section", () => {
    const rewritten = `[sad] She asked him to stay. He turned away.`;
    expect(sanitizeFishS2TaggedText(PROSE, rewritten)).toBe(PROSE);
    expect(
      sanitizeFishS2TaggedText(
        PROSE,
        `[whispering] ${PROSE} And then the narrator added a new sentence.`
      )
    ).toBe(PROSE);
  });

  it("does not treat existing [break] / [long-break] as a rewrite", () => {
    const original = `Chapter One\n[long-break]\nCall me Ishmael. [break] Some years ago.`;
    const tagged = `[calm] Chapter One\n[long-break]\n[nostalgic] Call me Ishmael. [break] Some years ago.`;
    const out = sanitizeFishS2TaggedText(original, tagged);
    expect(out).toContain("[calm]");
    expect(out).toContain("[nostalgic]");
    expect(out).toContain("[long-break]");
    expect(out).toContain("[break]");
    expect(proseFingerprint(out)).toBe(proseFingerprint(original));
  });

  it("caps extra emotion tags so a section is not tagged to death", () => {
    const sentences = Array.from(
      { length: 12 },
      (_, i) => `This is sentence number ${i} about the river.`
    );
    const original = sentences.join(" ");
    const tagged = sentences.map((s) => `[excited] ${s}`).join(" ");
    const out = sanitizeFishS2TaggedText(original, tagged);
    const emotionCount = (out.match(/\[excited\]/g) || []).length;
    expect(emotionCount).toBeGreaterThan(0);
    expect(emotionCount).toBeLessThanOrEqual(6);
    expect(proseFingerprint(out)).toBe(proseFingerprint(original));
  });

  it("scales the emotion cap with Whole-book length so a long speakable is not stuck at 6", () => {
    const sentences = Array.from(
      { length: 120 },
      (_, i) =>
        `This is sentence number ${i} about the river and the long evening light.`
    );
    const original = sentences.join(" ");
    expect(original.length).toBeGreaterThan(8000);
    const tagged = sentences.map((s) => `[excited] ${s}`).join(" ");
    const out = sanitizeFishS2TaggedText(original, tagged);
    const emotionCount = (out.match(/\[excited\]/g) || []).length;
    expect(emotionCount).toBeGreaterThan(6);
    expect(proseFingerprint(out)).toBe(proseFingerprint(original));
  });
});

describe("stripFishS2Cues / fingerprint", () => {
  it("fingerprint ignores allowlisted cues and whitespace", () => {
    expect(proseFingerprint("[happy] Hello   world.")).toBe(
      proseFingerprint("Hello world.")
    );
    expect(stripFishS2Cues("[long-break] Hello [break] world.")).toMatch(
      /Hello\s+world\./
    );
  });
});
