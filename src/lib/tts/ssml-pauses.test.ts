import { describe, expect, it } from "vitest";
import {
  FISH_LONG_PAUSE,
  FISH_SHORT_PAUSE,
  toFishNarrationScript,
} from "./narration-script";
import {
  EDGE_LONG_PAUSE,
  EDGE_SHORT_PAUSE,
  SSML_LONG_BREAK,
  SSML_SHORT_BREAK,
  escapeSsmlText,
  fishPausesToEdgeProsodyText,
  fishPausesToSsmlBody,
  scriptHasFishPauseTags,
  wrapGoogleSsml,
} from "./ssml-pauses";

const ACADEMIC = [
  "Abstract",
  "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
].join("\n\n");

describe("fishPausesToSsmlBody", () => {
  it("maps Fish [break] / [long-break] to timed SSML breaks", () => {
    const body = fishPausesToSsmlBody(
      `Hello ${FISH_SHORT_PAUSE} world\n${FISH_LONG_PAUSE}\nAgain.`
    );
    expect(body).toContain(SSML_SHORT_BREAK);
    expect(body).toContain(SSML_LONG_BREAK);
    expect(body).toContain("Hello");
    expect(body).toContain("world");
    expect(body).not.toMatch(/\[(?:long-)?break\]/i);
  });

  it("escapes spoken text and does not escape the break elements", () => {
    const body = fishPausesToSsmlBody(
      `Tom & Jerry <3 ${FISH_SHORT_PAUSE} next`
    );
    expect(body).toContain("Tom &amp; Jerry &lt;3");
    expect(body).toContain(SSML_SHORT_BREAK);
    expect(body).not.toContain("&lt;break");
    expect(escapeSsmlText(`a"b'`)).toBe("a&quot;b&apos;");
  });

  it("keeps the same sparse/normal placement as the Fish script", () => {
    const normal = toFishNarrationScript(ACADEMIC, { pauseStyle: "normal" });
    const sparse = toFishNarrationScript(ACADEMIC, { pauseStyle: "sparse" });
    expect(normal).toContain(FISH_SHORT_PAUSE);
    expect(sparse).not.toContain(FISH_SHORT_PAUSE);

    const normalSsml = fishPausesToSsmlBody(normal);
    const sparseSsml = fishPausesToSsmlBody(sparse);
    expect(normalSsml).toContain(SSML_SHORT_BREAK);
    expect(sparseSsml).not.toContain(SSML_SHORT_BREAK);
    expect(normalSsml).toContain(SSML_LONG_BREAK);
    expect(sparseSsml).toContain(SSML_LONG_BREAK);
    expect(scriptHasFishPauseTags(normal)).toBe(true);
    expect(scriptHasFishPauseTags(normalSsml)).toBe(false);
  });
});

describe("wrapGoogleSsml", () => {
  it("wraps the mapped body in a speak root", () => {
    const ssml = wrapGoogleSsml(`Hi ${FISH_LONG_PAUSE} there.`);
    expect(ssml.startsWith("<speak>")).toBe(true);
    expect(ssml.endsWith("</speak>")).toBe(true);
    expect(ssml).toContain(SSML_LONG_BREAK);
    expect(ssml).not.toContain(FISH_LONG_PAUSE);
  });
});

describe("fishPausesToEdgeProsodyText", () => {
  it("turns Fish pause tags into Edge-safe text pauses, never <break> markup", () => {
    const body = fishPausesToEdgeProsodyText(
      `Hello ${FISH_SHORT_PAUSE} world\n${FISH_LONG_PAUSE}\nAgain.`
    );
    expect(body).toContain("Hello");
    expect(body).toContain("world");
    expect(body).toContain(EDGE_SHORT_PAUSE.trim());
    expect(body).toContain(EDGE_LONG_PAUSE);
    expect(body).not.toMatch(/<break\b/i);
    expect(body).not.toMatch(/\[(?:long-)?break\]/i);
  });

  it("still escapes spoken XML so Edge SSML stays well-formed", () => {
    const body = fishPausesToEdgeProsodyText(
      `Tom & Jerry <3 ${FISH_SHORT_PAUSE} next`
    );
    expect(body).toContain("Tom &amp; Jerry &lt;3");
    expect(body).not.toMatch(/<break\b/i);
  });

  it("strips leftover emotion/tone cues so they are never spoken as words", () => {
    const src = `[calm] Hello ${FISH_SHORT_PAUSE} world [whispering]\n${FISH_LONG_PAUSE}\nagain.`;
    const ssml = fishPausesToSsmlBody(src);
    expect(ssml).toContain(SSML_SHORT_BREAK);
    expect(ssml).toContain(SSML_LONG_BREAK);
    expect(ssml).toContain("Hello");
    expect(ssml).not.toMatch(/\[[^\]]+\]/);
    expect(ssml).not.toMatch(/whispering|calm/i);

    const edge = fishPausesToEdgeProsodyText(src);
    expect(edge).toContain("Hello");
    expect(edge).toContain(EDGE_SHORT_PAUSE.trim());
    expect(edge).not.toMatch(/\[[^\]]+\]/);
    expect(edge).not.toMatch(/<break\b/i);
    expect(edge).not.toMatch(/whispering|calm/i);
  });
});
