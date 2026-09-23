import { describe, expect, it } from "vitest";
import {
  FISH_S2_ALLOWED_CUES,
  FISH_S2_PERFORMANCE_CUE_EVERY_CHARS,
  MAX_FISH_S2_PERFORMANCE_CUES,
  isAllowedFishS2Cue,
  maxFishS2PerformanceCuesForText,
  proseFingerprint,
  sanitizeFishS2TaggedText,
  stripFishS2Cues,
  stripNonPauseFishCues,
} from "./fish-s2-cues";

const PROSE = [
  'She whispered softly, "Stay close."',
  "He sighed and looked away across the dark water.",
].join(" ");

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

describe("sanitizeFishS2TaggedText", () => {
  it("keeps published and free-form tags when the prose is unchanged", () => {
    const tagged = `[whispering] She whispered softly, "Stay close." [sighing] He sighed and looked away across the dark water.`;
    const out = sanitizeFishS2TaggedText(PROSE, tagged);
    expect(out).toContain("[whispering]");
    expect(out).toContain("[sighing]");
    expect(proseFingerprint(out)).toBe(proseFingerprint(PROSE));
  });

  it("keeps free-form attitude cues that are outside the published table", () => {
    const tagged = `[cynical][matter-of-fact] ${PROSE} [aggressive undertone]`;
    const out = sanitizeFishS2TaggedText(PROSE, tagged);
    expect(out).toContain("[cynical]");
    expect(out).toContain("[matter-of-fact]");
    expect(out).toContain("[aggressive undertone]");
    const withUnknown = sanitizeFishS2TaggedText(
      PROSE,
      `[calm] ${PROSE} [totally-made-up]`
    );
    expect(withUnknown).toContain("[calm]");
    expect(withUnknown).toContain("[totally-made-up]");
    expect(proseFingerprint(withUnknown)).toBe(proseFingerprint(PROSE));
    expect(
      sanitizeFishS2TaggedText(PROSE, `[mystery] ${PROSE} extra?`)
    ).toBe(PROSE);
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

  it("keeps a cue on every sentence of expressive prose", () => {
    const sentences = Array.from(
      { length: 12 },
      (_, i) => `This is sentence number ${i} about the river.`
    );
    const original = sentences.join(" ");
    const tagged = sentences.map((s) => `[excited] ${s}`).join(" ");
    const out = sanitizeFishS2TaggedText(original, tagged);
    const emotionCount = (out.match(/\[excited\]/g) || []).length;
    expect(emotionCount).toBe(sentences.length);
    expect(emotionCount).toBeGreaterThan(10);
    expect(proseFingerprint(out)).toBe(proseFingerprint(original));
  });

  it("trims only a pathological cue pile past the length budget", () => {
    const tiny = Array.from({ length: 8 }, () => "No.").join(" ");
    const piled = Array.from(
      { length: 8 },
      () => "[angry][cynical][sarcastic] No."
    ).join(" ");
    const trimmed = sanitizeFishS2TaggedText(tiny, piled);
    const kept = (trimmed.match(/\[[^\]]+\]/g) || []).length;
    const budget = maxFishS2PerformanceCuesForText(tiny);
    expect(budget).toBeLessThan(8);
    expect(kept).toBe(budget);
    expect(proseFingerprint(trimmed)).toBe(proseFingerprint(tiny));
  });

  it("keeps a mix of emotion, tone, effect, and free-form tags", () => {
    const original = [
      'She whispered, "Stay close." He sighed.',
      "The crowd laughed once, and the room stayed still long enough for the line to carry both the laugh and the quiet afterward.",
    ].join(" ");
    const tagged = [
      '[sad][whispering] She whispered, "Stay close." [sighing] He sighed.',
      "[audience laughing] The crowd laughed once, and the room stayed still long enough for the line to carry both the laugh and the quiet afterward.",
    ].join(" ");
    const out = sanitizeFishS2TaggedText(original, tagged);
    expect(out).toContain("[sad]");
    expect(out).toContain("[whispering]");
    expect(out).toContain("[sighing]");
    expect(out).toContain("[audience laughing]");
    expect(proseFingerprint(out)).toBe(proseFingerprint(original));
    const layered = sanitizeFishS2TaggedText(
      original,
      `${tagged} [sound like a tired newsreader]`
    );
    expect(layered).toContain("[whispering]");
    expect(layered).toContain("[sighing]");
    expect(layered).toContain("[sound like a tired newsreader]");
    expect(proseFingerprint(layered)).toBe(proseFingerprint(original));
  });

  it("scales the cue budget with Whole-book length instead of a 240-tag ceiling", () => {
    const sentences = Array.from(
      { length: 120 },
      (_, i) =>
        `This is sentence number ${i} about the river and the long evening light.`
    );
    const original = sentences.join(" ");
    expect(original.length).toBeGreaterThan(8000);
    expect(maxFishS2PerformanceCuesForText(original)).toBeGreaterThan(120);
    const tagged = sentences.map((s) => `[excited] ${s}`).join(" ");
    const out = sanitizeFishS2TaggedText(original, tagged);
    const emotionCount = (out.match(/\[excited\]/g) || []).length;
    expect(emotionCount).toBe(sentences.length);
    expect(proseFingerprint(out)).toBe(proseFingerprint(original));
  });

  it("documents the remaining safety ceiling", () => {
    expect(FISH_S2_PERFORMANCE_CUE_EVERY_CHARS).toBe(40);
    expect(maxFishS2PerformanceCuesForText("x".repeat(8000))).toBe(200);
    expect(maxFishS2PerformanceCuesForText("x".repeat(480_000))).toBe(
      MAX_FISH_S2_PERFORMANCE_CUES
    );
    expect(maxFishS2PerformanceCuesForText("x".repeat(2_000_000))).toBe(
      MAX_FISH_S2_PERFORMANCE_CUES
    );
  });

  it("drops an oversized bracket and keeps a normal free-form cue", () => {
    const huge = "word ".repeat(80).trim();
    const out = sanitizeFishS2TaggedText(PROSE, `[cynical] ${PROSE} [${huge}]`);
    expect(out).toContain("[cynical]");
    expect(out).not.toContain(huge.slice(0, 40));
    expect(proseFingerprint(out)).toBe(proseFingerprint(PROSE));
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
