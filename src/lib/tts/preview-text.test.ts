import { describe, expect, it } from "vitest";
import {
  PREVIEW_TEXT,
  previewTextForAccent,
  sniffPreviewMime,
} from "./preview-text";

describe("preview-text", () => {
  it("keeps the sample to one short sentence", () => {
    expect(PREVIEW_TEXT.length).toBeLessThan(90);
    expect(PREVIEW_TEXT.toLowerCase()).toContain("echomancer");
  });

  it("uses accent-forward preview lines", () => {
    expect(previewTextForAccent("british").toLowerCase()).toContain("british");
    expect(previewTextForAccent("australian").toLowerCase()).toContain(
      "australian"
    );
    expect(previewTextForAccent(null)).toBe(PREVIEW_TEXT);
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
