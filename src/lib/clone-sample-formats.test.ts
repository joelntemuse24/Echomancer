import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CLONE_SAMPLE_MB,
  MIN_CLONE_SAMPLE_BYTES,
  SUPPORTED_CLONE_SAMPLE_ACCEPT,
  contentTypeForCloneSample,
  isAllowedCloneSample,
  maxCloneSampleBytes,
  maxCloneSampleMb,
  safeCloneSampleExtension,
  sniffCloneSampleFormat,
  looksLikeVideoCloneSample,
} from "@/lib/clone-sample-formats";

describe("clone-sample-formats", () => {
  it("recognises video containers by name or MIME for the decode guard", () => {
    expect(looksLikeVideoCloneSample("memo.mov")).toBe(true);
    expect(looksLikeVideoCloneSample("memo.mp4")).toBe(true);
    expect(looksLikeVideoCloneSample("clip.webm")).toBe(true);
    expect(looksLikeVideoCloneSample("memo", "video/quicktime")).toBe(true);
    expect(looksLikeVideoCloneSample("memo", "video/mp4; charset=binary")).toBe(
      true
    );
    expect(looksLikeVideoCloneSample("voice.wav")).toBe(false);
    expect(looksLikeVideoCloneSample("memo.m4a")).toBe(false);
    expect(looksLikeVideoCloneSample("memo", "audio/mp4")).toBe(false);
    expect(looksLikeVideoCloneSample("memo", "")).toBe(false);
  });
  it("caps samples at tens of MB, not the Vercel function body", () => {
    expect(DEFAULT_MAX_CLONE_SAMPLE_MB).toBeGreaterThanOrEqual(16);
    expect(maxCloneSampleMb()).toBe(DEFAULT_MAX_CLONE_SAMPLE_MB);
    expect(maxCloneSampleBytes()).toBeGreaterThan(5 * 1024 * 1024);
    expect(MIN_CLONE_SAMPLE_BYTES).toBe(8 * 1024);
  });

  it("accepts audio/* types and known extensions", () => {
    expect(isAllowedCloneSample("me.wav", "audio/wav")).toBe(true);
    expect(isAllowedCloneSample("me.mp3", "audio/mpeg")).toBe(true);
    expect(isAllowedCloneSample("me.m4a", "audio/mp4")).toBe(true);
    expect(isAllowedCloneSample("clip.opus", "audio/ogg")).toBe(true);
    expect(contentTypeForCloneSample("voice.wav", "audio/wav")).toBe("audio/wav");
    expect(contentTypeForCloneSample("voice.mp3")).toBe("audio/mpeg");
  });

  it("accepts phone video containers that carry the voice memo's audio", () => {
    expect(isAllowedCloneSample("memo.mp4", "video/mp4")).toBe(true);
    expect(isAllowedCloneSample("memo.mov", "video/quicktime")).toBe(true);
    expect(contentTypeForCloneSample("memo.mp4", "video/mp4")).toBe("video/mp4");
  });

  it("rejects non-audio types even with a plausible name", () => {
    expect(isAllowedCloneSample("book.pdf", "application/pdf")).toBe(false);
    expect(isAllowedCloneSample("notes.txt", "text/plain")).toBe(false);
    expect(isAllowedCloneSample("blob.bin", "application/octet-stream")).toBe(
      false
    );
    expect(contentTypeForCloneSample("book.pdf", "application/pdf")).toBeNull();
  });

  it("maps a known audio type to a single allowlisted extension", () => {
    expect(safeCloneSampleExtension("voice.MP3", "audio/mpeg")).toBe("mp3");
    expect(safeCloneSampleExtension("a.mp3/../../etc/passwd", "audio/mpeg")).toBe(
      "mp3"
    );
    expect(safeCloneSampleExtension("weird", "audio/wav")).toBe("wav");
    expect(safeCloneSampleExtension("weird", "video/mp4")).toBe("mp4");
  });

  it("sniffs audio magic bytes when the name and MIME lie", () => {
    const wav = new Uint8Array(64);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set(new TextEncoder().encode("WAVE"), 8);
    expect(sniffCloneSampleFormat(wav)).toBe("wav");

    expect(
      sniffCloneSampleFormat(new TextEncoder().encode("ID3 rest of the tag"))
    ).toBe("mp3");

    const opus = new Uint8Array(64);
    opus.set(new TextEncoder().encode("OggS"), 0);
    opus.set(new TextEncoder().encode("OpusHead"), 16);
    expect(sniffCloneSampleFormat(opus)).toBe("opus");

    const ogg = new Uint8Array(64);
    ogg.set(new TextEncoder().encode("OggS"), 0);
    expect(sniffCloneSampleFormat(ogg)).toBe("ogg");

    const mp4 = new Uint8Array(64);
    mp4.set([0, 0, 0, 24], 0);
    mp4.set(new TextEncoder().encode("ftyp"), 4);
    expect(sniffCloneSampleFormat(mp4)).toBe("m4a");

    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x96, 0x01]);
    expect(sniffCloneSampleFormat(webm)).toBe("webm");

    expect(sniffCloneSampleFormat(new TextEncoder().encode("plain text"))).toBeNull();
    expect(sniffCloneSampleFormat(new Uint8Array(64))).toBeNull();
  });

  it("lists extensions and MIME types in the picker accept attribute", () => {
    const parts = SUPPORTED_CLONE_SAMPLE_ACCEPT.split(",");
    expect(parts).toContain(".wav");
    expect(parts).toContain(".mp4");
    expect(parts).toContain("audio/wav");
    expect(parts).toContain("video/mp4");
  });
});
