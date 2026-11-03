import { describe, expect, it } from "vitest";
import {
  chapterNumberOf,
  demoteSubsections,
  hasContainerLines,
  hasNestedLevels,
  isContainerLine,
  parentNumberOf,
} from "@/lib/chapter-levels";

function entry(title: string, level = 1) {
  return { title, level, blockIndex: 0 };
}

function levelsOf(entries: { title: string; level: number }[]) {
  return Object.fromEntries(demoteSubsections(entries).map((item) => [item.title, item.level]));
}

describe("number helpers", () => {
  it("reads the parent of a sub-section number", () => {
    expect(parentNumberOf("2.1 Model and Architectures")).toBe("2");
    expect(parentNumberOf("4.3.2 Routing")).toBe("4");
    expect(parentNumberOf("A.2 Pre-training Procedure")).toBe("A");
    expect(parentNumberOf("2 Introduction")).toBeNull();
  });

  it("reads a chapter number but not a sub-section's", () => {
    expect(chapterNumberOf("2 Approach")).toBe("2");
    expect(chapterNumberOf("Section 5")).toBe("5");
    expect(chapterNumberOf("A Appendix")).toBe("A");
    expect(chapterNumberOf("2.1 Background")).toBeNull();
    expect(chapterNumberOf("Chapter 3")).toBeNull();
  });
});

describe("demoteSubsections", () => {
  it("uses the source's own nesting first", () => {
    const levels = levelsOf([
      entry("Part One", 1),
      entry("Chapter One", 2),
      entry("Chapter Two", 2),
      entry("Part Two", 1),
    ]);
    expect(levels["Part One"]).toBe(1);
    expect(levels["Chapter One"]).toBe(2);
    expect(levels["Part Two"]).toBe(1);
  });

  it("normalises a tree that starts at h2", () => {
    const out = demoteSubsections([entry("Part One", 2), entry("Chapter One", 3)]);
    expect(out.map((item) => item.level)).toEqual([1, 2]);
  });

  it("demotes numbered sub-sections under their chapter", () => {
    const levels = levelsOf([
      entry("1 Introduction"),
      entry("2 Approach"),
      entry("2.1 Model and Architectures"),
      entry("2.2 Training"),
      entry("3 Results"),
      entry("3.1 Metrics"),
    ]);
    expect(levels["1 Introduction"]).toBe(1);
    expect(levels["2 Approach"]).toBe(1);
    expect(levels["2.1 Model and Architectures"]).toBe(2);
    expect(levels["2.2 Training"]).toBe(2);
    expect(levels["3 Results"]).toBe(1);
    expect(levels["3.1 Metrics"]).toBe(2);
  });

  it("keeps a numbered title that has no parent in the list", () => {
    const levels = levelsOf([entry("Introduction"), entry("1.5 million tonnes of coal")]);
    expect(levels["Introduction"]).toBe(1);
    expect(levels["1.5 million tonnes of coal"]).toBe(1);
  });

  it("demotes h3 and deeper when the source's levels say so", () => {
    // Rule 1 applies here: the source already ranks h1 above h2/h3, so the
    // normalisation maps the shallowest to 1 and everything deeper to 2.
    const levels = levelsOf([
      entry("The Quay at Dusk", 1),
      entry("Working the tide", 2),
      entry("The ledger", 3),
      entry("The tide turns", 3),
    ]);
    expect(levels["The Quay at Dusk"]).toBe(1);
    expect(levels["Working the tide"]).toBe(2);
    expect(levels["The ledger"]).toBe(2);
    expect(levels["The tide turns"]).toBe(2);
  });

  it("groups a flat list under its Book/Part containers", () => {
    const levels = levelsOf([
      entry("Preface"),
      entry("Book One: 1805"),
      entry("Book One · Chapter I"),
      entry("Book One · Chapter II"),
      entry("Book Two: 1805"),
      entry("Book Two · Chapter I"),
    ]);
    expect(levels["Preface"]).toBe(1);
    expect(levels["Book One: 1805"]).toBe(1);
    expect(levels["Book One · Chapter I"]).toBe(2);
    expect(levels["Book Two: 1805"]).toBe(1);
    expect(levels["Book Two · Chapter I"]).toBe(2);
  });

  it("leaves a plain chapter list flat", () => {
    const entries = [entry("Chapter One"), entry("Chapter Two"), entry("Chapter Three")];
    expect(demoteSubsections(entries).every((item) => item.level === 1)).toBe(true);
  });

  it("never invents a level for a title that is not a container", () => {
    const entries = [entry("Loomings"), entry("The Carpet-Bag"), entry("The Spouter-Inn")];
    expect(demoteSubsections(entries)).toEqual(entries);
  });
});

describe("container lines", () => {
  it("recognises a container and rejects a prefixed chapter title", () => {
    expect(isContainerLine("Part One")).toBe(true);
    expect(isContainerLine("BOOK THE FIRST")).toBe(true);
    expect(isContainerLine("Volume Two")).toBe(true);
    expect(isContainerLine("Book One: 1805")).toBe(true);
    expect(isContainerLine("Book Two · Chapter I")).toBe(false);
    expect(isContainerLine("Part One · Chapter III")).toBe(false);
    expect(isContainerLine("Chapter One")).toBe(false);
  });

  it("reports what an outline contains", () => {
    expect(hasContainerLines([entry("Book One: 1805"), entry("Chapter I")])).toBe(true);
    expect(hasContainerLines([entry("Chapter I"), entry("Chapter II")])).toBe(false);
    expect(hasNestedLevels([entry("Part One", 1), entry("Chapter One", 2)])).toBe(true);
    expect(hasNestedLevels([entry("Chapter One"), entry("Chapter Two")])).toBe(false);
  });
});
