import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_LABELS,
  CLASSIFIER_MODEL,
  HEADING_LABEL,
  HYPOTHESIS_TEMPLATE,
  PROSE_LABEL,
  classifierEnabled,
  classifierThresholds,
  isBorderlineLine,
  refineHeadingIndexes,
  scoreHeadingLine,
  setScorerForTests,
} from "@/lib/chapter-classifier";
import { headingLineCandidates } from "@/lib/book-chapters";

const BOOK = [
  "THE WHALE",
  "",
  "The Spouter-Inn",
  "",
  "part of the foot-board of the bed and a line of the wall, but no",
  "",
  "He was pacing the room swiftly, eagerly, with his head sunk upon his chest.",
  "",
  "Loomings",
  "",
  "So fare thee well, poor devil of a Sub-Sub, whose commentator I am.",
  "",
  "The Counterpane",
  "",
  "I stuffed a shirt or two into my old carpet-bag, tucked it under my arm, and started.",
].join("\n");

describe("the classifier gate", () => {
  it("is off unless asked for", () => {
    expect(classifierEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(classifierEnabled({ CHAPTER_CLASSIFIER: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(classifierEnabled({ CHAPTER_CLASSIFIER: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("uses calibrated thresholds and an MIT model", () => {
    const defaults = classifierThresholds({} as NodeJS.ProcessEnv);
    expect(defaults.vetoBelow).toBeCloseTo(0.22);
    expect(defaults.promoteAbove).toBeCloseTo(0.72);
    // A promotion always needs a higher score than keeping a line.
    expect(defaults.promoteAbove).toBeGreaterThan(defaults.vetoBelow);
    expect(
      classifierThresholds({ CHAPTER_CLASSIFIER_VETO_BELOW: "0.4" } as NodeJS.ProcessEnv)
        .vetoBelow
    ).toBe(0.4);
    // A nonsense threshold is ignored rather than narrowing to nothing.
    expect(
      classifierThresholds({ CHAPTER_CLASSIFIER_VETO_BELOW: "0" } as NodeJS.ProcessEnv)
        .vetoBelow
    ).toBe(0.22);
    expect(CLASSIFIER_MODEL).toBe("MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33");
    expect(CLASSIFIER_LABELS).toEqual([HEADING_LABEL, PROSE_LABEL]);
    expect(HYPOTHESIS_TEMPLATE).toBe("This text is {}.");
  });

  it("selects only short, title-shaped, unpunctuated lines", () => {
    expect(isBorderlineLine("Loomings")).toBe(true);
    expect(isBorderlineLine("The Counterpane")).toBe(true);
    expect(isBorderlineLine("THE WHALE")).toBe(true);
    // Prose: ends a sentence, or starts lowercase.
    expect(isBorderlineLine("He was pacing the room swiftly.")).toBe(false);
    expect(isBorderlineLine("part of the foot-board of the bed")).toBe(false);
    // Too long, or not words at all.
    expect(isBorderlineLine("A title that runs on and on ".repeat(6))).toBe(false);
    expect(isBorderlineLine("12345")).toBe(false);
  });
});

describe("refineHeadingIndexes", () => {
  it("promotes a bare title line the regex could not see", async () => {
    const { spans, flags } = headingLineCandidates(BOOK);
    const accepted = flags.map((flag, i) => (flag ? i : -1)).filter((i) => i >= 0);
    const pool = spans.map((_, i) => i);
    const { indexes, stats } = await refineHeadingIndexes(BOOK, accepted, {
      candidates: pool,
      // "part of the foot-board…" is prose; the title lines are headings. That
      // is exactly the call the regex gets wrong.
      classify: async (text) => (/^part of/i.test(text) ? 0.05 : 0.95),
    });
    const titles = indexes.map((i) => spans[i]!.para);
    expect(titles).toContain("Loomings");
    expect(titles).toContain("The Counterpane");
    expect(stats.promoted).toBeGreaterThan(0);
  });

  it("vetoes a line the model calls prose below the threshold", async () => {
    // Only some of these are borderline: a long paragraph is never sent.
    const accepted = [0, 1, 4];
    const borderline = accepted.filter((i) => isBorderlineLine(BOOK.split("\n\n")[i]!));
    const { indexes, stats } = await refineHeadingIndexes(BOOK, accepted, {
      classify: async () => 0.05,
    });
    expect(indexes).toEqual([]);
    expect(stats.changed).toBe(borderline.length);
    expect(stats.promoted).toBe(0);
  });

  it("needs a higher score to promote than to keep", async () => {
    const accepted = [0];
    const pool = [0, 1];
    // 0.7 keeps the accepted line but is not enough to promote the rejected one.
    const { indexes, stats } = await refineHeadingIndexes(BOOK, accepted, {
      candidates: pool,
      classify: async () => 0.7,
    });
    expect(indexes).toEqual([0]);
    expect(stats.promoted).toBe(0);
    expect(stats.changed).toBe(0);
  });

  it("leaves the outline alone when a line cannot be scored", async () => {
    const accepted = [0, 1, 4];
    const { indexes, stats, skipped } = await refineHeadingIndexes(BOOK, accepted, {
      classify: async () => {
        throw new Error("no model");
      },
    });
    // A thrown classification is a skipped line, not a failed book.
    expect(indexes).toEqual(accepted);
    expect(stats.changed).toBe(0);
    expect(skipped).toBeNull();
  });

  it("stops at its budget instead of running long", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `Title ${i}\n\nBody ${i}.`).join("\n\n");
    const { skipped, stats } = await refineHeadingIndexes(text, [0, 2, 4, 6], {
      classify: async () => 0.9,
      budgetMs: -1,
    });
    expect(skipped).toBe("budget exhausted");
    expect(stats.scored).toBe(0);
  });
});

describe("scoreHeadingLine", () => {
  it("uses an injected classifier", async () => {
    await expect(scoreHeadingLine("Loomings", { classify: async () => 0.8 })).resolves.toBe(0.8);
  });

  it("uses the loaded scorer and restores after a stub", async () => {
    setScorerForTests(async () => 0.5);
    await expect(scoreHeadingLine("Loomings")).resolves.toBe(0.5);
    setScorerForTests(null);
  });
});
