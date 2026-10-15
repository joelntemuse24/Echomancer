import { describe, expect, it } from "vitest";
import { toSpeakableText } from "./speakable-text";
import { normalizeNumbersAndAbbreviations, normalizeSpeakableText, toTitleCase } from "./normalize-speakable";

describe("toTitleCase", () => {
  it("keeps Roman numerals uppercase", () => {
    expect(toTitleCase("CHAPTER II")).toBe("Chapter II");
    expect(toTitleCase("CHAPTER XII. MR. COLLINS")).toBe("Chapter XII. Mr. Collins");
    expect(toTitleCase("BOOK ONE: 1805")).toBe("Book One: 1805");
    expect(toTitleCase("PART XLIV")).toBe("Part XLIV");
  });

  it("does not uppercase words that only look Roman", () => {
    expect(toTitleCase("THE MILL ON THE FLOSS")).toBe("The Mill On The Floss");
    expect(toTitleCase("LILI")).toBe("Lili");
    expect(toTitleCase("MIMIC")).toBe("Mimic");
  });
});

describe("normalizeSpeakableText", () => {
  it("strips footnote asterisks that TTS would speak", () => {
    expect(normalizeSpeakableText("The claim* was later withdrawn.")).toBe(
      "The claim was later withdrawn."
    );
    expect(normalizeSpeakableText("A note.† Next sentence.")).toBe(
      "A note. Next sentence."
    );
  });

  it("unwraps editorial brackets and keeps the inner words", () => {
    expect(
      normalizeSpeakableText("He wrote [like this] in the margin.")
    ).toBe("He wrote like this in the margin.");
  });

  it("drops numeric citation brackets instead of speaking the numbers", () => {
    expect(
      normalizeSpeakableText("See the appendix [1] and the table [12-14].")
    ).toBe("See the appendix and the table.");
  });

  it("preserves Fish pause cues so later scripts stay unspeakable as words", () => {
    expect(
      normalizeSpeakableText("Hello [break] world [long-break] again.")
    ).toBe("Hello [break] world [long-break] again.");
  });

  it("converts ALL-CAPS title lines to Title Case", () => {
    expect(normalizeSpeakableText("THE TWO CITIES")).toBe("The Two Cities");
  });

  it("keeps ALL-CAPS titles when title cleanup is off", () => {
    expect(
      normalizeSpeakableText("THE TWO CITIES", { normalizeTitles: false })
    ).toBe("THE TWO CITIES");
  });

  it("does not Title-Case mixed-case prose or short acronym lines", () => {
    expect(normalizeSpeakableText("Call me Ishmael.")).toBe("Call me Ishmael.");
    expect(normalizeSpeakableText("USA")).toBe("USA");
  });

  it("keeps a lone Roman-numeral line as a spoken chapter title", () => {
    const spoken = normalizeSpeakableText(
      ["Opening remarks.", "II", "The argument continues here."].join("\n\n")
    );
    expect(spoken).toContain("Chapter II");
    expect(spoken).toContain("Opening remarks.");
    expect(spoken).toContain("The argument continues here.");
  });

  it("collapses pathological whitespace but keeps paragraph structure", () => {
    expect(
      normalizeSpeakableText("Hello    world.\n\n\n\nNext   paragraph.")
    ).toBe("Hello world.\n\nNext paragraph.");
  });

  it("does not invent essay-specific rewrites", () => {
    const literary =
      "One must imagine Sisyphus happy, even when the stone rolls back.";
    expect(normalizeSpeakableText(literary)).toBe(literary);
  });

  it("is idempotent", () => {
    const once = normalizeSpeakableText(
      "THE REPUBLIC\n\nHe said [sic] the law* was just.\n\nIII\n\nMore prose."
    );
    expect(normalizeSpeakableText(once)).toBe(once);
  });

  it("returns empty string for blank input", () => {
    expect(normalizeSpeakableText("")).toBe("");
    expect(normalizeSpeakableText("  \n\n  ")).toBe("");
  });
});

describe("toSpeakableText applies normalizeSpeakableText", () => {
  it("cleans asterisks, brackets, ALL-CAPS titles, and Roman section lines", () => {
    const spoken = toSpeakableText(
      [
        "THE REPUBLIC",
        "II",
        "The philosopher* returned [like this] to the cave, and the fire still burned against the wall long enough to count as prose.",
      ].join("\n\n")
    );

    expect(spoken).toMatch(/The Republic/);
    expect(spoken).not.toMatch(/THE REPUBLIC/);
    expect(spoken).toMatch(/Chapter II/);
    expect(spoken).toMatch(/philosopher returned like this to the cave/);
    expect(spoken).not.toMatch(/\*/);
    expect(spoken).not.toMatch(/\[like this\]/);
  });
});

describe("normalizeNumbersAndAbbreviations", () => {
  it.each([
    ["In 1776 and 2005.", "In seventeen seventy-six and two thousand five."],
    ["In 1905 and 1800.", "In nineteen oh five and eighteen hundred."],
    ["1776 people and 1,200 books.", "one thousand seven hundred seventy-six people and one thousand two hundred books."],
    ["The 1st, 22nd, 3rd and 12th.", "The first, twenty-second, third and twelfth."],
    ["$5, $3.50, £2m, £1.01, €2.", "five dollars, three dollars and fifty cents, two million pounds, one pound and one penny, two euros."],
    ["12.5% and 0.05 and 1,200.", "twelve point five percent and zero point zero five and one thousand two hundred."],
    ["1861-65; pp. 4-7; 2–5.", "eighteen sixty-one to eighteen sixty-five; pages four to seven; two to five."],
    ["The 19th century and 21st-century art.", "The nineteenth century and twenty-first-century art."],
    ["George III read Part IV and Chapter II. I agree.", "George the third read Part four and Chapter two. I agree."],
    ["Victoria VII in the XIX century; Chapter I. I said hello.", "Victoria the seventh in the nineteenth century; Chapter one. I said hello."],
    ["Mr. Jones, Mrs. Smith, Dr. Green, Gen. Lee, Col. Hall and Capt. Cook.", "Mister Jones, Missus Smith, Doctor Green, General Lee, Colonel Hall and Captain Cook."],
    ["St. George on 12 King St. Near St. Paul.", "Saint George on twelve King Street Near Saint Paul."],
    ["e.g. apples, i.e. fruit, etc. vs. bread.", "for example apples, that is fruit, et cetera versus bread."],
    ["No. 5; No. thanks.", "Number five; No. thanks."],
    ["Jan. 1, Dec. 22; Jan. wrote.", "January one, December twenty-two; Jan. wrote."],
    ["Chapter 1776 and room 2005.", "Chapter one thousand seven hundred seventy-six and room two thousand five."],
    ["Vitamin D and World War II.", "Vitamin D and World War II."],
    ["One must imagine Sisyphus happy.", "One must imagine Sisyphus happy."],
    ["", ""],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeNumbersAndAbbreviations(input)).toBe(expected);
    expect(normalizeNumbersAndAbbreviations(expected)).toBe(expected);
  });

  it("expands all month abbreviations only before numbers", () => {
    expect(normalizeNumbersAndAbbreviations("Jan. 1 Feb. 2 Mar. 3 Apr. 4 May. 5 Jun. 6 Jul. 7 Aug. 8 Sep. 9 Oct. 10 Nov. 11 Dec. 12"))
      .toBe("January one February two March three April four May five June six July seven August eight September nine October ten November eleven December twelve");
  });
});
