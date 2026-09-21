import { describe, expect, it } from "vitest";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { buildFrozenScript } from "@/lib/tts/frozen-script";
import { packSpeakableSections } from "@/lib/tts/split-text";
import {
  hardMaxCharsForModel,
  maxCharsForModel,
} from "@/lib/tts/section-size";
import {
  GOOGLE_SSML_HARD_MAX_BYTES,
  GOOGLE_TTS_INPUT_MAX_BYTES,
  googleSynthesisSsmlUtf8Bytes,
  wrapGoogleSsml,
} from "@/lib/tts/ssml-pauses";

/**
 * ~43.5k-char Whole-book speakable with OpenRouter-style pause tags,
 * curly punctuation, and ampersands — the live Randolph failure mode
 * (paragraphs sized at the catalog 4500-char target so char packing
 * emits ~4500-char windows).
 */
function taggedChunk(chars: number): string {
  const sentence =
    "The dominant sequence transduction models are based on complex recurrent & convolutional networks that include an encoder and a decoder — “attention” is all you need. [break]";
  let out = "";
  while (out.length < chars) {
    out += (out ? " " : "") + sentence;
  }
  return out.slice(0, chars);
}

function taggedRandolphBook(targetChars = 43_500): string {
  const parts: string[] = [];
  while (parts.join("\n\n").length < targetChars) {
    parts.push(taggedChunk(4_500));
  }
  return parts.join("\n\n");
}

function googlePackOpts() {
  const catalogMax = 4500;
  return {
    maxChars: maxCharsForModel({ provider: "google", catalogMax }),
    hardMaxChars: hardMaxCharsForModel({ provider: "google", catalogMax }),
  };
}

describe("Google Whole-book SSML byte budget", () => {
  it("documents that a ~4500-char tagged section exceeds Google's 5000-byte input limit", () => {
    const section = taggedRandolphBook(4_500).slice(0, 4_500);
    const ssml = wrapGoogleSsml(
      narrationScriptForSynthesis(section, "google")
    );
    expect(Buffer.byteLength(ssml, "utf8")).toBeGreaterThan(
      GOOGLE_TTS_INPUT_MAX_BYTES
    );
    expect(googleSynthesisSsmlUtf8Bytes(section)).toBeGreaterThan(
      GOOGLE_TTS_INPUT_MAX_BYTES
    );
  });

  it("packs every Google section so final SSML is ≤ 5000 UTF-8 bytes", () => {
    const book = taggedRandolphBook(43_500);
    const { maxChars, hardMaxChars } = googlePackOpts();
    expect(maxChars).toBe(4500);

    const charPacked = packSpeakableSections(book, maxChars, { hardMaxChars });
    const charPackedMaxBytes = Math.max(
      ...charPacked.map((s) => googleSynthesisSsmlUtf8Bytes(s.text))
    );
    expect(charPackedMaxBytes).toBeGreaterThan(GOOGLE_TTS_INPUT_MAX_BYTES);

    const packed = packSpeakableSections(book, maxChars, {
      hardMaxChars,
      measure: googleSynthesisSsmlUtf8Bytes,
    });

    expect(packed.length).toBeGreaterThan(1);
    for (const section of packed) {
      const bytes = googleSynthesisSsmlUtf8Bytes(section.text);
      expect(bytes).toBeLessThanOrEqual(GOOGLE_TTS_INPUT_MAX_BYTES);
      expect(bytes).toBeLessThanOrEqual(GOOGLE_SSML_HARD_MAX_BYTES);
    }
  });

  it("buildFrozenScript Google path honors the SSML byte ceiling", () => {
    const rawText = taggedRandolphBook(43_500);
    const { maxChars, hardMaxChars } = googlePackOpts();
    const frozen = buildFrozenScript({
      rawText,
      maxChars,
      hardMaxChars,
      packProvider: "google",
    });
    expect(frozen.sections.length).toBeGreaterThan(1);
    for (const section of frozen.sections) {
      expect(googleSynthesisSsmlUtf8Bytes(section.text)).toBeLessThanOrEqual(
        GOOGLE_SSML_HARD_MAX_BYTES
      );
    }
  });

  it("does not shrink Edge / Fish packing targets", () => {
    const book = taggedRandolphBook(20_000);
    const edge = packSpeakableSections(book, 4000);
    const maxEdge = Math.max(...edge.map((s) => s.text.length));
    expect(maxEdge).toBeGreaterThan(3000);
    expect(maxEdge).toBeLessThanOrEqual(4000 + Math.round(4000 * 0.25));
  });
});
