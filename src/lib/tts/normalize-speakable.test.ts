import { describe, expect, it } from "vitest";
import { toSpeakableText } from "./speakable-text";
import { normalizeSpeakableText } from "./normalize-speakable";

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

  it("treats a lone Roman-numeral line as a section break, not spoken I/II/III", () => {
    const spoken = normalizeSpeakableText(
      ["Opening remarks.", "II", "The argument continues here."].join("\n\n")
    );
    expect(spoken).toBe("Opening remarks.\n\nThe argument continues here.");
    expect(spoken).not.toMatch(/^\s*II\s*$/m);
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
    expect(spoken).not.toMatch(/^\s*II\s*$/m);
    expect(spoken).toMatch(/philosopher returned like this to the cave/);
    expect(spoken).not.toMatch(/\*/);
    expect(spoken).not.toMatch(/\[like this\]/);
  });
});
