import { describe, expect, it } from "vitest";
import { toSpeakableText } from "./speakable-text";
import { ATTENTION_GLUED_FOUR_PAGE } from "./speakable-text.test";
import {
  FISH_LONG_PAUSE,
  FISH_SHORT_PAUSE,
  FISH_WHOLE_BOOK_DELIVERY_PREFIX,
  decideLongSentenceCommaBreak,
  narrationScriptForSynthesis,
  scriptPauseScore,
  toFishNarrationScript,
} from "./narration-script";

const CLEAN_PROSE = [
  "Call me Ishmael. Some years ago I thought I would sail about a little and see the watery part of the world.",
  "It is a way I have of driving off the spleen and regulating the circulation.",
].join("\n\n");

describe("toFishNarrationScript", () => {
  it("inserts Fish S2 [long-break] after headings and between paragraphs", () => {
    const spoken = toSpeakableText(ATTENTION_GLUED_FOUR_PAGE);
    const script = toFishNarrationScript(spoken);

    expect(script).toContain(FISH_LONG_PAUSE);
    expect(script).toMatch(/Abstract\n\[long-break\]/);
    expect(script).toMatch(/Introduction\n\[long-break\]/);
    expect(script).toMatch(/dominant sequence transduction/);
    expect(script).not.toMatch(/\[long-break\]\s*\[long-break\]/);
  });

  it("adds [break] between long academic sentences, not every short beat", () => {
    const academic = [
      "Abstract",
      "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
    ].join("\n\n");
    const script = toFishNarrationScript(academic);
    expect(script).toContain(FISH_SHORT_PAUSE);
    expect(script).toMatch(/decoder\.\s*\[break\]\s*We propose/);

    const dialogue = toFishNarrationScript(
      '"Hello," he said. "Are you sure?" she asked. "Yes," he said.'
    );
    expect(dialogue).not.toContain(FISH_SHORT_PAUSE);
  });

  it("is idempotent and uses only documented S2 pause tags", () => {
    const spoken = toSpeakableText(ATTENTION_GLUED_FOUR_PAGE);
    const once = toFishNarrationScript(spoken);
    expect(toFishNarrationScript(once)).toBe(once);
    expect(once).not.toMatch(/\(break\)|\(long-break\)|<break/i);
    expect(once).not.toMatch(/\[pause\]|\[long pause\]|\[short pause\]/i);
  });

  it("gives clean paragraph-broken prose long pauses without sounding tagged-to-death", () => {
    const script = toFishNarrationScript(CLEAN_PROSE);
    expect(script).toContain(FISH_LONG_PAUSE);
    expect(script).toMatch(/world\.\n\n\[long-break\]\n\nIt is a way/);
    expect(script).not.toContain(FISH_SHORT_PAUSE);
  });
});

describe("scriptPauseScore", () => {
  it("scores glued academic after formatting as having real pause opportunities", () => {
    const raw = ATTENTION_GLUED_FOUR_PAGE;
    expect(raw.includes("\n\n")).toBe(false);
    const before = scriptPauseScore(raw);
    const after = scriptPauseScore(
      toFishNarrationScript(toSpeakableText(raw))
    );
    expect(after.paragraphBreaks).toBeGreaterThan(before.paragraphBreaks);
    expect(after.longBreakTags).toBeGreaterThan(0);
    expect(after.charsPerParagraph).toBeLessThan(before.charsPerParagraph);
  });
});

describe("decideLongSentenceCommaBreak", () => {
  it("does not break short sentences or after every and/that/comma", () => {
    const short =
      "The river was wide, and the night was long, and that was enough.";
    expect(decideLongSentenceCommaBreak(short)).toBeNull();
  });

  it("picks at most one mid-comma on a very long sentence", () => {
    const long = [
      "The lecture wandered through the first premise of the argument",
      "and then, after a careful restatement of the opposing view that had occupied the previous hour",
      "it returned to the original claim with a slower cadence than the opening.",
    ].join(" ");
    expect(long.length).toBeGreaterThan(220);
    const at = decideLongSentenceCommaBreak(long);
    expect(at).not.toBeNull();
    expect(long[at!]).toBe(",");
    expect(decideLongSentenceCommaBreak(long.slice(0, 200))).toBeNull();
  });

  it("skips a comma that only introduces and/that", () => {
    const padded =
      "The opening claim of the seminar occupied the entire first hour of discussion, and that remaining stretch of the afternoon was spent restating the same premise with examples drawn from the previous week of lectures on method.";
    expect(padded.length).toBeGreaterThan(220);
    expect(decideLongSentenceCommaBreak(padded)).toBeNull();
  });
});

describe("narrationScriptForSynthesis", () => {
  it("injects Fish tags only for the Fish adapter", () => {
    const spoken = toSpeakableText(ATTENTION_GLUED_FOUR_PAGE);
    expect(narrationScriptForSynthesis(spoken, "fish")).toContain(
      FISH_LONG_PAUSE
    );
    expect(narrationScriptForSynthesis(spoken, "openrouter")).not.toContain(
      FISH_LONG_PAUSE
    );
    expect(narrationScriptForSynthesis(spoken, "openrouter")).toBe(spoken);
  });

  it("adds the Whole-book delivery prefix only when asked, and never for other providers", () => {
    const spoken = "Call me Ishmael.";
    const live = narrationScriptForSynthesis(spoken, "fish");
    const takehome = narrationScriptForSynthesis(spoken, "fish", {
      deliveryPrefix: true,
    });
    expect(live.startsWith(FISH_WHOLE_BOOK_DELIVERY_PREFIX)).toBe(false);
    expect(takehome.startsWith(FISH_WHOLE_BOOK_DELIVERY_PREFIX)).toBe(true);
    expect(
      narrationScriptForSynthesis(spoken, "openrouter", {
        deliveryPrefix: true,
      })
    ).toBe(spoken);
  });

  it("inserts a rare [break] at the chosen mid-comma of a long Fish sentence", () => {
    const long = [
      "The lecture wandered through the first premise of the argument",
      "and then, after a careful restatement of the opposing view that had occupied the previous hour",
      "it returned to the original claim with a slower cadence than the opening.",
    ].join(" ");
    const script = toFishNarrationScript(long);
    const at = decideLongSentenceCommaBreak(long);
    expect(at).not.toBeNull();
    expect(script).toContain(`${long.slice(0, at! + 1)} ${FISH_SHORT_PAUSE}`);
    expect((script.match(/\[break\]/g) || []).length).toBe(1);
  });
});
