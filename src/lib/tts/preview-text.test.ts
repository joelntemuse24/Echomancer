import { describe, expect, it } from "vitest";
import { scriptDeliverySample } from "./delivery-sample";
import {
  DELIVERY_COMPARE_TEXT,
  PREVIEW_TEXT,
  isEmptyOrSilentAudio,
  previewTextForAccent,
  sniffPreviewMime,
} from "./preview-text";

describe("preview-text", () => {
  it("keeps the sample to one short sentence", () => {
    expect(PREVIEW_TEXT.length).toBeLessThan(90);
    expect(PREVIEW_TEXT.toLowerCase()).toContain("echomancer");
  });

  it("gives play-both a short fixed line with Fish cues and a plain Edge script", () => {
    expect(DELIVERY_COMPARE_TEXT.length).toBeLessThan(220);
    expect(DELIVERY_COMPARE_TEXT).toContain("Chapter One");
    expect(DELIVERY_COMPARE_TEXT).toContain("We leave at dawn");
    const fish = scriptDeliverySample("compare", "fish");
    const edge = scriptDeliverySample("compare", "edge");
    expect(fish).toContain("[soft tone]");
    expect(fish).toContain("[emphasis]");
    expect(edge).not.toContain("[soft tone]");
    expect(edge).not.toContain("[emphasis]");
    expect(edge).toContain("We leave at dawn");
    expect(scriptDeliverySample("preview", "fish")).toBe(PREVIEW_TEXT);
  });

  it("keeps preview text plain (accent applied at synthesis)", () => {
    expect(previewTextForAccent("british")).toBe(PREVIEW_TEXT);
    expect(previewTextForAccent("australian")).toBe(PREVIEW_TEXT);
  });

  it("re-exports the shared empty-audio guard", () => {
    // Detection itself is covered in audio-guard.test.ts; this only pins the
    // re-export that preview code has always imported from here.
    const emptyWavHeader = Buffer.from(
      "RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\xc0]\x00\x00\x80\xbb\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00",
      "binary"
    );
    expect(isEmptyOrSilentAudio(emptyWavHeader)).toBe(true);

    const audible = Buffer.alloc(1000, 0x33);
    expect(isEmptyOrSilentAudio(audible)).toBe(false);
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
