import { describe, expect, it } from "vitest";
import { applyExpressiveFishDelivery } from "./fish-delivery-heat";
import {
  FISH_S2_ALLOWED_CUES,
  FISH_S2_PERFORMANCE_CUE_EVERY_CHARS,
  MAX_FISH_S2_PERFORMANCE_CUES,
  isAllowedFishS2Cue,
  isHotFishDeliveryCue,
  maxFishS2PerformanceCuesForText,
  proseFingerprint,
  isBreathProneFishCue,
  restrainBreathFishCues,
  restrainHotFishCues,
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

describe("restrainHotFishCues", () => {
  it("remaps shouting, screaming, hysteria, and extreme excitement onto steady delivery cues", () => {
    expect(isHotFishDeliveryCue("shouting")).toBe(true);
    expect(isHotFishDeliveryCue("Screaming")).toBe(true);
    expect(isHotFishDeliveryCue("hysterical")).toBe(true);
    expect(isHotFishDeliveryCue("extremely excited")).toBe(true);
    expect(isHotFishDeliveryCue("very excited")).toBe(true);
    expect(isHotFishDeliveryCue("extremely angry")).toBe(true);
    expect(isHotFishDeliveryCue("slightly excited")).toBe(false);
    expect(isHotFishDeliveryCue("calm")).toBe(false);
    expect(isHotFishDeliveryCue("soft tone")).toBe(false);
    expect(isHotFishDeliveryCue("emphasis")).toBe(false);
    expect(isHotFishDeliveryCue("curious")).toBe(false);
    expect(isAllowedFishS2Cue("shouting")).toBe(true);

    const prose =
      'The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."';
    const cooled = restrainHotFishCues(
      `[shouting][screaming][hysterical][extremely excited] ${prose}`
    );
    expect(cooled).not.toMatch(
      /\[(?:shouting|screaming|hysterical|extremely excited|very excited)\]/i
    );
    expect(cooled).not.toMatch(/\[(?:calm|soft tone)\]/);
    expect(cooled).toMatch(/\[confident\]/);
    expect(cooled).toMatch(/\[emphasis\]/);
    expect(cooled).toMatch(/\[curious\]/);
    expect(cooled).toMatch(/\[indifferent\]/);
    expect(proseFingerprint(cooled)).toBe(proseFingerprint(prose));
    expect(restrainHotFishCues(cooled)).toBe(cooled);
  });

  it("keeps a warranted shout in narration mode and drops it only for the compare remap", () => {
    const line = '[screaming][shouting] She screamed, "Get down!"';
    const narration = restrainHotFishCues(line, "narration");
    expect(narration).toContain("[screaming]");
    expect(narration).toContain("[shouting]");
    const compare = restrainHotFishCues(line, "expressive");
    expect(compare).not.toMatch(/\[(?:screaming|shouting)\]/i);
    expect(compare).toMatch(/\[(?:confident|emphasis|curious|indifferent)\]/);
    expect(compare).not.toMatch(/\[(?:calm|soft tone)\]/);
    expect(compare).toContain("She screamed");
  });

  it("keeps a warranted shout on Whole-book twins and remaps calm exposition", () => {
    const shout = '[shouting] He shouted, "Get out!"';
    expect(applyExpressiveFishDelivery(shout, "fish", "standard")).toContain(
      "[shouting]"
    );
    expect(applyExpressiveFishDelivery(shout, "fish", "michelle")).toContain(
      "[shouting]"
    );
    const calm = "[shouting][screaming] The harbor was quiet after the rain.";
    const twin = applyExpressiveFishDelivery(calm, "fish", "standard");
    expect(twin).not.toMatch(/\[(?:shouting|screaming)\]/i);
    expect(twin).toMatch(/\[(?:confident|emphasis|curious|indifferent)\]/);
    expect(twin).not.toMatch(/\[(?:calm|soft tone)\]/);
    expect(twin).toContain("harbor was quiet");
    expect(applyExpressiveFishDelivery(calm, "fish", "randolph")).not.toMatch(
      /\[screaming\]/i
    );
    expect(applyExpressiveFishDelivery(calm, "fish", "clara")).toBe(calm);
    expect(applyExpressiveFishDelivery(calm, "edge", "standard")).toBe(calm);
  });
});

describe("restrainBreathFishCues", () => {
  it("drops soft tone and unwarranted calm, and keeps depicted effects", () => {
    expect(isBreathProneFishCue("soft tone")).toBe(true);
    expect(isBreathProneFishCue("sighing")).toBe(true);
    expect(isBreathProneFishCue("calm")).toBe(false);
    expect(isBreathProneFishCue("confident")).toBe(false);
    expect(isBreathProneFishCue("shouting")).toBe(false);

    const line =
      '[soft tone][gasping] The policy landed softly. [sighing] Commentators called it a sighing consensus. [whispering] She whispered, "Stay." [shouting] He shouted, "Get out!"';
    const out = restrainBreathFishCues(line);
    expect(out).not.toMatch(/\[(?:soft tone|gasping|sighing|calm)\]/i);
    expect(out).toContain("[whispering]");
    expect(out).toContain("[shouting]");
    expect(out).toContain("landed softly");
    expect(out).toContain('She whispered, "Stay."');
    expect(restrainBreathFishCues(out)).toBe(out);

    const depicted = restrainBreathFishCues(
      '[sighing] She sighed and closed the ledger. [whispering] He said it in a whisper.'
    );
    expect(depicted).toContain("[sighing]");
    expect(depicted).toContain("[whispering]");
    expect(restrainBreathFishCues(depicted)).toBe(depicted);
  });

  it("cools default calm on exposition and keeps a warranted calm that is not stacked", () => {
    const exposition =
      "[calm][soft tone][emphasis] The model was trained on public essays about chips and export rules.";
    const cooled = restrainBreathFishCues(exposition);
    expect(cooled).not.toMatch(/\[(?:calm|soft tone)\]/i);
    expect(cooled).toContain("[emphasis]");
    expect(cooled).toContain("export rules");

    const pauses =
      "[calm] The argument continued [break] through the next section.\n\n[long-break]";
    const paced = restrainBreathFishCues(pauses);
    expect(paced).not.toContain("[calm]");
    expect(paced).toContain("[break]");
    expect(paced).toContain("[long-break]");

    const stacked = "[calm][emphasis] She spoke calmly about the harbor.";
    const unstacked = restrainBreathFishCues(stacked);
    expect(unstacked).not.toContain("[calm]");
    expect(unstacked).toContain("[emphasis]");
    expect(unstacked).toContain("spoke calmly");

    const warranted = "[calm] She spoke calmly and kept the room still.";
    expect(restrainBreathFishCues(warranted)).toContain("[calm]");
    expect(
      restrainBreathFishCues("[slightly calm] The lecture ran another hour.")
    ).not.toMatch(/calm/i);
    expect(
      restrainBreathFishCues(
        "[calm][calm] She spoke calmly once, then moved on."
      ).match(/\[calm\]/g)
    ).toHaveLength(1);
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

  it("strips invented brackets and keeps allowlisted cues", () => {
    const stripped = sanitizeFishS2TaggedText(
      PROSE,
      `[cynical][matter-of-fact] ${PROSE} [aggressive undertone]`
    );
    expect(stripped).not.toMatch(/\[cynical\]|\[matter-of-fact\]|\[aggressive/);
    expect(proseFingerprint(stripped)).toBe(proseFingerprint(PROSE));
    const withUnknown = sanitizeFishS2TaggedText(
      PROSE,
      `[calm] ${PROSE} [totally-made-up]`
    );
    expect(withUnknown).toContain("[calm]");
    expect(withUnknown).not.toContain("totally-made-up");
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
      () => "[angry][shouting][sarcastic] No."
    ).join(" ");
    const trimmed = sanitizeFishS2TaggedText(tiny, piled);
    const kept = (trimmed.match(/\[[^\]]+\]/g) || []).length;
    const budget = maxFishS2PerformanceCuesForText(tiny);
    expect(budget).toBeLessThan(8);
    expect(kept).toBe(budget);
    expect(proseFingerprint(trimmed)).toBe(proseFingerprint(tiny));
  });

  it("keeps a mix of allowlisted emotion, tone, and effect tags", () => {
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
    expect(layered).not.toMatch(/sound like|newsreader/i);
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

  it("strips a long invented bracket and keeps an allowlisted cue", () => {
    const huge = "word ".repeat(80).trim();
    const out = sanitizeFishS2TaggedText(PROSE, `[calm] ${PROSE} [${huge}]`);
    expect(out).toContain("[calm]");
    expect(out).not.toContain(huge.slice(0, 40));
    expect(out).not.toContain("[cynical]");
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
