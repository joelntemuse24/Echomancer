import { describe, expect, it } from "vitest";
import { splitSentences, toSpeakableText } from "./speakable-text";
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

  it("drops asterisk scene breaks instead of speaking them", () => {
    const script = toFishNarrationScript(
      [
        "The lamps were lit along the quay.",
        "***",
        "Night settled over the harbour.",
      ].join("\n\n")
    );
    expect(script).not.toContain("***");
    expect(script).toContain("The lamps were lit along the quay.");
    expect(script).toContain("Night settled over the harbour.");
    expect(script).toContain(FISH_LONG_PAUSE);
    expect(script).not.toMatch(/\[long-break\]\s*\[long-break\]/);
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
  it("keeps pause tags for Edge and Google, and sends Fish plain text", () => {
    const spoken = toSpeakableText(ATTENTION_GLUED_FOUR_PAGE);
    expect(narrationScriptForSynthesis(spoken, "fish")).not.toMatch(/\[[^\]]+\]/);
    expect(narrationScriptForSynthesis(spoken, "edge")).toContain(
      FISH_LONG_PAUSE
    );
    expect(narrationScriptForSynthesis(spoken, "google")).toContain(
      FISH_LONG_PAUSE
    );
    expect(narrationScriptForSynthesis(spoken, "openrouter")).not.toContain(
      FISH_LONG_PAUSE
    );
    expect(narrationScriptForSynthesis(spoken, "openrouter")).toBe(spoken);
  });

  it("omits mid-sentence and between-sentence breaks in sparse mode", () => {
    const long = [
      "The lecture wandered through the first premise of the argument",
      "and then, after a careful restatement of the opposing view that had occupied the previous hour",
      "it returned to the original claim with a slower cadence than the opening.",
    ].join(" ");
    const sparse = toFishNarrationScript(long, { pauseStyle: "sparse" });
    expect(sparse).not.toContain(FISH_SHORT_PAUSE);
    expect(sparse).toContain(long.slice(0, 40));
  });

  it("gives Fish headings punctuation and no cue tags, and keeps pause tags off emotion words for Edge", () => {
    const spoken = [
      "Foreword",
      "The lamps were lit along the quay and the tide was turning before midnight.",
      "***",
      "Chapter One",
      "Night settled over the harbour and the boats were still.",
      "Coda",
      "The harbour was quiet again by morning.",
    ].join("\n\n");
    const fish = narrationScriptForSynthesis(spoken, "fish");
    const edge = narrationScriptForSynthesis(spoken, "edge");
    expect(fish).toContain("Foreword.");
    expect(fish).toContain("Chapter One.");
    expect(fish).toContain("Coda.");
    expect(fish).not.toMatch(/\[[^\]]+\]/);
    expect(fish).not.toContain("***");
    expect(edge).toMatch(/Foreword\n\[long-break\]/);
    expect(edge).toMatch(/Coda\n\[long-break\]/);
    expect(edge).not.toContain("[soft tone]");
    expect(edge).not.toContain("[confident]");
    expect(edge).not.toContain("[emphasis]");
    expect(edge).not.toContain("***");
    expect(narrationScriptForSynthesis(fish, "fish")).toBe(fish);

    const shouted = narrationScriptForSynthesis(
      'Obstinate, headstrong girl!',
      "fish"
    );
    expect(shouted).toBe("Obstinate, headstrong girl!");
    expect(shouted).not.toContain("[excited]");
  });

  it("sends Fish no bracket cues and strips emotion tags for Edge/Google", () => {
    const spoken = 'She whispered softly, "Stay close." He sighed and looked away.';
    const fish = narrationScriptForSynthesis(spoken, "fish");
    const edge = narrationScriptForSynthesis(spoken, "edge");
    const google = narrationScriptForSynthesis(spoken, "google");
    expect(fish).not.toMatch(/\[[^\]]+\]/);
    expect(fish).toContain("whispered softly");
    const noted = narrationScriptForSynthesis(
      "See the ledger [see note] before dawn.",
      "fish"
    );
    expect(noted).toContain("(see note)");
    expect(noted).not.toMatch(/\[[^\]]+\]/);
    expect(edge).not.toMatch(/\[whispering\]|\[sighing\]|\[excited\]|\[nostalgic\]/);
    expect(google).not.toMatch(/\[whispering\]|\[sighing\]|\[excited\]|\[nostalgic\]/);
    const leftover = narrationScriptForSynthesis(
      "[nostalgic] Call me Ishmael. [totally-made-up] Stay close.",
      "edge"
    );
    expect(leftover).not.toMatch(
      /\[nostalgic\]|\[totally-made-up\]|\[whispering\]|\[calm\]/
    );
    expect(leftover).toContain("Call me Ishmael");
    expect(leftover).toContain("Stay close");

    const figurative = narrationScriptForSynthesis(
      "The policy landed softly. Commentators called it a sighing consensus.",
      "fish"
    );
    expect(figurative).not.toMatch(
      /\[(?:whispering|sighing|soft tone|gasping|groaning)\]/i
    );
    expect(figurative).toContain("landed softly");
    expect(figurative).toContain("sighing consensus");
  });

  it("does not inject the retired seminar prefix for any provider", () => {
    const dialogue = [
      '"Hello," he said.',
      '"Are you sure?" she asked.',
      '"Yes," he said, and they walked on.',
    ].join("\n\n");
    const spoken = "Call me Ishmael.";
    expect(
      narrationScriptForSynthesis(dialogue, "fish", { deliveryPrefix: true })
    ).not.toContain(FISH_WHOLE_BOOK_DELIVERY_PREFIX);
    expect(
      narrationScriptForSynthesis(spoken, "fish", { deliveryPrefix: true })
    ).not.toContain(FISH_WHOLE_BOOK_DELIVERY_PREFIX);
    expect(
      narrationScriptForSynthesis(spoken, "fish").startsWith(
        FISH_WHOLE_BOOK_DELIVERY_PREFIX
      )
    ).toBe(false);
    expect(
      narrationScriptForSynthesis(spoken, "openrouter", {
        deliveryPrefix: true,
      })
    ).toBe(spoken);
    expect(
      narrationScriptForSynthesis(spoken, "edge", { deliveryPrefix: true })
    ).not.toContain(FISH_WHOLE_BOOK_DELIVERY_PREFIX);
    expect(
      narrationScriptForSynthesis(spoken, "google", { deliveryPrefix: true })
    ).not.toContain(FISH_WHOLE_BOOK_DELIVERY_PREFIX);
  });

  it("turns a book's square brackets into parentheses and still hears the heading", () => {
    const spoken = [
      "[cynical lecture tone] Foreword",
      "The lamps were lit along the quay and the tide was turning.",
    ].join("\n\n");
    const script = narrationScriptForSynthesis(spoken, "fish", {
      deliveryPrefix: true,
    });
    expect(script).toContain("(cynical lecture tone) Foreword.");
    expect(script).not.toMatch(/\[[^\]]+\]/);
    expect(script).not.toContain(FISH_WHOLE_BOOK_DELIVERY_PREFIX);
  });

  it("does not split common abbreviations into sentences", () => {
    expect(splitSentences("Mr. Darcy arrived. Elizabeth watched him.")).toEqual([
      "Mr. Darcy arrived.",
      "Elizabeth watched him.",
    ]);
    expect(
      splitSentences("J. K. Rowling wrote it. No. 12 was missing.")
    ).toEqual(["J. K. Rowling wrote it.", "No. 12 was missing."]);
    const paragraph = [
      "Mr. Darcy arrived. Mrs. Bennet spoke. Ms. Lucas waited. Dr. Grant nodded.",
      "St. James was quiet. Prof. Hale agreed. Sr. and Jr. both came. He vs. she.",
      "See e.g. the note and i.e. the clause. Etc. was written out. No. 12 was missing.",
    ].join(" ");
    const edge = narrationScriptForSynthesis(paragraph, "edge");
    expect(edge).not.toMatch(
      /\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc|e\.g|i\.e|No)\. \[break\]/i
    );
    const fish = narrationScriptForSynthesis(paragraph, "fish");
    expect(fish).toContain("Mr. Darcy");
    expect(fish).not.toMatch(/\[[^\]]+\]/);
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
