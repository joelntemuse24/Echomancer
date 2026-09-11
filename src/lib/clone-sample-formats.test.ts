import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CLONE_SAMPLE_MB,
  MIN_CLONE_SAMPLE_BYTES,
  contentTypeForCloneSample,
  isAllowedCloneSample,
  maxCloneSampleBytes,
  maxCloneSampleMb,
  safeCloneSampleExtension,
} from "@/lib/clone-sample-formats";

describe("clone-sample-formats", () => {
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
  });
});
