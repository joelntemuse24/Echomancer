import { describe, expect, it } from "vitest";
import {
  FISH_COMPARE_SCRIPT,
  scriptDeliverySample,
  scriptedDeliverySample,
} from "./delivery-sample";
import { FISH_S2_EFFECT_CUES } from "./fish-s2-cues";
import {
  DELIVERY_COMPARE_TEXT,
  PREVIEW_TEXT,
  previewTextForAccent,
  sniffPreviewMime,
} from "./preview-text";

describe("preview-text", () => {
  it("keeps the sample to one short sentence", () => {
    expect(PREVIEW_TEXT.length).toBeLessThan(90);
    expect(PREVIEW_TEXT.toLowerCase()).toContain("echomancer");
  });

  it("gives play-both a short fixed line with no Fish cues and a pause on Edge", () => {
    expect(DELIVERY_COMPARE_TEXT.length).toBeLessThan(220);
    expect(DELIVERY_COMPARE_TEXT).toContain("Chapter One");
    expect(DELIVERY_COMPARE_TEXT).toContain("We leave at dawn");
    const fish = scriptDeliverySample("compare", "fish");
    const edge = scriptDeliverySample("compare", "edge");
    expect(fish).toBe(FISH_COMPARE_SCRIPT);
    expect(fish).toBe(
      [
        "Chapter One.",
        "",
        'The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."',
      ].join("\n")
    );
    expect(fish).not.toMatch(/\[[^\]]+\]/);
    expect(fish).not.toMatch(/\[(?:soft tone|whispering|sighing|gasping)\]/i);
    expect(fish).not.toContain("[emphasis]");
    expect(fish).not.toContain("[long-break]");
    expect(fish).not.toContain("[break]");
    for (const effect of FISH_S2_EFFECT_CUES) {
      expect(fish.toLowerCase()).not.toContain(`[${effect}]`);
    }
    expect(edge).not.toContain("[soft tone]");
    expect(edge).not.toContain("[confident]");
    expect(edge).not.toContain("[emphasis]");
    expect(edge).toContain("[long-break]");
    expect(edge).toContain("Chapter One");
    expect(edge).toContain("We leave at dawn");
    expect(scriptDeliverySample("preview", "fish")).toBe(PREVIEW_TEXT);
    expect(fish).toBe(
      scriptedDeliverySample(DELIVERY_COMPARE_TEXT, "fish")
    );
    expect(edge).toBe(scriptedDeliverySample(DELIVERY_COMPARE_TEXT, "edge"));
  });

  it("keeps Andrew compare Fish free of shouting, screaming, and extreme excitement", () => {
    const fish = scriptDeliverySample("compare", "fish");
    const edge = scriptDeliverySample("compare", "edge");
    expect(fish).not.toMatch(/\[(?:shouting|screaming|hysterical)\]/i);
    expect(fish).not.toMatch(/\[(?:very|extremely) excited\]/i);
    expect(fish).not.toMatch(/\[[^\]]+\]/);
    expect(fish).not.toContain("[soft tone]");
    expect(edge).not.toMatch(/\[(?:shouting|screaming|hysterical|soft tone)\]/i);
    expect(edge).toContain("We leave at dawn");

    const hot = scriptedDeliverySample(
      [
        "Chapter One",
        "",
        '[shouting][screaming][hysterical][extremely excited] The harbor was quiet. She screamed, "We leave at dawn!"',
      ].join("\n"),
      "fish"
    );
    expect(hot).not.toMatch(/\[(?:shouting|screaming|hysterical)\]/i);
    expect(hot).not.toMatch(/\[extremely excited\]/i);
    expect(hot).not.toMatch(/\[(?:emphasis|long-break|break)\]/i);
    expect(hot).not.toMatch(/\[[^\]]+\]/);
    expect(hot).not.toContain("[soft tone]");
    expect(hot).toContain("We leave at dawn");
    expect(hot).toContain("She screamed");

    const sighed = scriptedDeliverySample(
      [
        "Chapter One",
        "",
        '[sighing][gasping][groaning] He sighed, then whispered, "We leave at dawn."',
      ].join("\n"),
      "fish"
    );
    expect(sighed).not.toMatch(/\[[^\]]+\]/);
    expect(sighed).not.toMatch(
      /\[(?:sighing|gasping|groaning|whispering|panting|laughing|soft tone)\]/i
    );
    expect(sighed).toContain("He sighed");
    expect(sighed).toContain("whispered");
    expect(scriptedDeliverySample(FISH_COMPARE_SCRIPT, "fish")).toBe(
      FISH_COMPARE_SCRIPT
    );
  });

  it("keeps preview text plain (accent applied at synthesis)", () => {
    expect(previewTextForAccent("british")).toBe(PREVIEW_TEXT);
    expect(previewTextForAccent("australian")).toBe(PREVIEW_TEXT);
  });

  it("sniffs wav / mpeg from magic bytes", () => {
    const wav = new Uint8Array(12);
    wav.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    expect(sniffPreviewMime(wav.buffer)).toBe("audio/wav");

    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x03]);
    expect(sniffPreviewMime(mp3.buffer)).toBe("audio/mpeg");

    expect(sniffPreviewMime(new Uint8Array([1, 2, 3]).buffer, "audio/ogg")).toBe(
      "audio/ogg"
    );
  });
});
