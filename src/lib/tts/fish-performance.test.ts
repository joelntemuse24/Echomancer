import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import {
  applyFishPerformance,
  canonicalPerformanceCue,
  clearFishPerformanceMarks,
  fishPerformanceSampling,
  FISH_PERFORMANCE_MARKS_INSTRUCTION,
  normalizePerformanceMarks,
  performanceAnchor,
  rememberFishPerformanceMarks,
  resolveChunkMarks,
  takeFishPerformanceMarks,
} from "@/lib/tts/fish-performance";
import {
  fishPerformanceScript,
  fishSpokenSection,
  narrationScriptForSynthesis,
  toFishPlainNarration,
} from "@/lib/tts/narration-script";
import { takehomeCacheVariant } from "@/lib/tts/process-job";

/**
 * One passage, plain and annotated. No audio is rendered.
 * The bracketed lines are refusals: an unknown tag and a crowd effect.
 */
const PASSAGE = [
  "Chapter 2.",
  "",
  "The harbor was quiet after the rain. [narrator voice] She stood at the rail and watched the water. [audience laughing]",
  "",
  `"Don't tell anyone," she whispered. "They are still in the house."`,
  "",
  `He sighed. "I wish we had left yesterday."`,
  "",
  `"Get down!" he shouted, as the beam swept the quay.`,
  "",
  "She ran, breathless, toward the dark street.",
].join("\n");

const SIGH_MARK = {
  anchor: performanceAnchor(`He sighed. "I wish we had left yesterday."`)!,
  cue: "sad",
};

const ANNOTATED = [
  "Chapter 2.",
  "",
  "The harbor was quiet after the rain. She stood at the rail and watched the water.",
  "",
  `[whispering] "Don't tell anyone," she whispered. [whispering] "They are still in the house."`,
  "",
  `[sighing] [sad] He sighed. "I wish we had left yesterday."`,
  "",
  `[shouting] "Get down!" he shouted, as the beam swept the quay.`,
  "",
  "[in a hurry tone] She ran, breathless, toward the dark street.",
].join("\n");

afterEach(() => {
  delete process.env.FISH_S2_PERFORMANCE;
  delete process.env.MODAL_S2_SAMPLING;
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.CLONE_TTS_PROVIDER;
  clearFishPerformanceMarks();
});

describe("fish performance flag", () => {
  it("leaves the Fish script and the lane text unchanged while off", () => {
    const plain = narrationScriptForSynthesis(PASSAGE, "fish");
    expect(plain).not.toMatch(/\[[^\]]+\]/);
    expect(plain).toContain("(narrator voice)");
    expect(plain).not.toContain("audience laughing");
    expect(plain).not.toContain("[whispering]");
    expect(fishSpokenSection(PASSAGE)).toBe(PASSAGE);
    expect(fishPerformanceSampling()).toBeNull();
  });

  it("annotates the same passage from the words and a listen-prep mark", () => {
    process.env.FISH_S2_PERFORMANCE = "1";
    const spoken = fishPerformanceScript(PASSAGE, {
      marks: [SIGH_MARK, { anchor: "the harbor was quiet after the rain", cue: "audience laughing" }],
    });
    expect(spoken).toBe(ANNOTATED);
    expect(spoken).not.toContain("narrator voice");
    expect(spoken).not.toContain("audience laughing");
    expect(fishPerformanceScript(spoken, { marks: [SIGH_MARK] })).toBe(spoken);
    expect(fishSpokenSection(PASSAGE, { marks: [SIGH_MARK] })).toBe(spoken);
  });

  it("carries a whisper into a quoted next section and stops at a new sentence", () => {
    process.env.FISH_S2_PERFORMANCE = "1";
    const previous = `"Don't tell anyone," she whispered. "They are still in the house."`;
    expect(
      fishPerformanceScript(`"They will hear us."`, { previousText: previous })
    ).toBe(`[whispering] "They will hear us."`);
    expect(
      fishPerformanceScript("The morning was bright and still.", { previousText: previous })
    ).toBe("The morning was bright and still.");
  });

  it("does not tag Edge, and leaves the preview one-liner alone", () => {
    process.env.FISH_S2_PERFORMANCE = "1";
    const edge = narrationScriptForSynthesis(PASSAGE, "edge");
    expect(edge).not.toMatch(/\[(?:whispering|sighing|shouting|sad|in a hurry tone)\]/);
    expect(narrationScriptForSynthesis(PREVIEW_TEXT, "fish")).toBe(
      toFishPlainNarration(PREVIEW_TEXT)
    );
  });

  it("keeps model emotions sparse", () => {
    process.env.FISH_S2_PERFORMANCE = "1";
    const first = "The room had gone cold and nobody spoke for a while.";
    const second = "She folded the letter and set it on the table.";
    const tagged = applyFishPerformance(`${first}\n\n${second}`, {
      marks: [
        { anchor: performanceAnchor(first)!, cue: "sad" },
        { anchor: performanceAnchor(second)!, cue: "angry" },
      ],
    });
    expect(tagged).toContain("[sad]");
    expect(tagged).not.toContain("[angry]");
  });

  it("caps tag density and inserts one in-sentence break", () => {
    process.env.FISH_S2_PERFORMANCE = "1";
    const many = Array.from({ length: 8 }, () => "She whispered the next line to him.").join(
      "\n\n"
    );
    expect(applyFishPerformance(many).match(/\[whispering\]/g)?.length).toBe(6);
    const beat =
      "She waited at the rail for a long time, listening to the water move against the piles, and then she said it was too late to go back ... the lights on the far shore had already gone out for the night.";
    const broken = applyFishPerformance(beat);
    expect(broken.match(/\[break\]/g)?.length).toBe(1);
    expect(broken.endsWith("[break]")).toBe(false);
    expect(applyFishPerformance("She stopped ... then left.")).not.toContain("[break]");
  });

  it("refuses unknown cues and keeps a sane anchor", () => {
    process.env.FISH_S2_PERFORMANCE = "1";
    expect(canonicalPerformanceCue("narrator voice")).toBeNull();
    expect(canonicalPerformanceCue("audience laughing")).toBeNull();
    expect(canonicalPerformanceCue("slightly sad")).toBe("slightly sad");
    expect(canonicalPerformanceCue("whispering")).toBe("whispering");
    const marks = resolveChunkMarks(
      [
        { id: 1, cue: "narrator voice" },
        { id: 1, cue: "whispering" },
        { id: 2, cue: "sad" },
      ],
      [
        { id: 1, text: `"Don't tell anyone," she whispered.` },
        { id: 2, text: "He sighed and looked away from the harbor." },
      ],
      [2],
      []
    );
    expect(marks).toEqual([
      {
        anchor: performanceAnchor(`"Don't tell anyone," she whispered.`)!,
        cue: "whispering",
      },
    ]);
    expect(normalizePerformanceMarks([{ anchor: "he sighed and", cue: "snoring" }])).toEqual([]);
  });

  it("moves the cache variant only while the flag is on", () => {
    expect(takehomeCacheVariant("fish", "standard")).toBe("fish-plain-v1");
    process.env.FISH_S2_PERFORMANCE = "1";
    expect(takehomeCacheVariant("fish", "standard")).toBe("fish-performance-v1");
    process.env.MODAL_S2_TTS_URL = "https://example.modal.run";
    process.env.CLONE_TTS_PROVIDER = "modal";
    expect(takehomeCacheVariant("fish", "clone:abc")).toMatch(/-perf$/);
    delete process.env.MODAL_S2_TTS_URL;
    delete process.env.CLONE_TTS_PROVIDER;
  });

  it("clamps hosted sampling to the API range", () => {
    process.env.FISH_S2_PERFORMANCE = "1";
    expect(fishPerformanceSampling()).toEqual({ temperature: 0.9, topP: 0.9 });
    process.env.MODAL_S2_SAMPLING = "2,0";
    expect(fishPerformanceSampling()).toEqual({ temperature: 1, topP: 0.06 });
  });

  it("stashes marks for the upload without a second read", () => {
    const marks = [{ anchor: "he sighed and looked", cue: "sad" }];
    rememberFishPerformanceMarks("upload-1", marks);
    expect(takeFishPerformanceMarks("upload-1")).toEqual(marks);
  });

  it("keeps the marks instruction short", () => {
    expect(FISH_PERFORMANCE_MARKS_INSTRUCTION.length).toBeLessThan(900);
  });
});
