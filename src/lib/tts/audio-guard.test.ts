import { describe, expect, it } from "vitest";
import {
  MIN_AUDIBLE_BYTES,
  hasNonZeroByte,
  isAllZeroBytes,
  isEmptyOrSilentAudio,
  isEmptyOrSilentStreamPayload,
} from "./audio-guard";
import { createWavHeader, pcmToWav } from "./pcm-wav";

function wavWithDataLength(dataLength: number, fill = 0): Buffer {
  const pcm = Buffer.alloc(dataLength, fill);
  return Buffer.concat([createWavHeader(dataLength), pcm]);
}

describe("isEmptyOrSilentAudio", () => {
  it("rejects a bare WAV header with no samples", () => {
    expect(isEmptyOrSilentAudio(wavWithDataLength(0))).toBe(true);
  });

  it("rejects a large WAV whose samples are all zero", () => {
    expect(isEmptyOrSilentAudio(wavWithDataLength(48_000))).toBe(true);
  });

  it("accepts a WAV carrying real samples", () => {
    expect(isEmptyOrSilentAudio(wavWithDataLength(48_000, 0x42))).toBe(false);
  });

  it("rejects an all-zero MP3-sized buffer", () => {
    // A provider that answers 200 with zero-filled bytes is still silence.
    expect(isEmptyOrSilentAudio(Buffer.alloc(64_000))).toBe(true);
  });

  it("accepts MP3 bytes with a frame header and content", () => {
    const mp3 = Buffer.alloc(4096, 0x5a);
    mp3[0] = 0xff;
    mp3[1] = 0xfb;
    expect(isEmptyOrSilentAudio(mp3)).toBe(false);
  });

  it("rejects buffers too short to hold audible audio", () => {
    expect(isEmptyOrSilentAudio(Buffer.alloc(MIN_AUDIBLE_BYTES - 1, 0x11))).toBe(
      true
    );
    expect(isEmptyOrSilentAudio(Buffer.alloc(MIN_AUDIBLE_BYTES, 0x11))).toBe(
      false
    );
  });

  it("rejects null and empty input", () => {
    expect(isEmptyOrSilentAudio(null)).toBe(true);
    expect(isEmptyOrSilentAudio(undefined)).toBe(true);
    expect(isEmptyOrSilentAudio(Buffer.alloc(0))).toBe(true);
  });

  it("accepts PCM wrapped as WAV once it has content", () => {
    const pcm = Buffer.alloc(2048);
    pcm.writeInt16LE(3000, 100);
    expect(isEmptyOrSilentAudio(pcmToWav(pcm))).toBe(false);
  });

  it("rejects raw PCM that is pure silence", () => {
    expect(isEmptyOrSilentAudio(pcmToWav(Buffer.alloc(2048)))).toBe(true);
  });
});

describe("byte helpers", () => {
  it("detects all-zero buffers", () => {
    expect(isAllZeroBytes(Buffer.alloc(10))).toBe(true);
    expect(isAllZeroBytes(Buffer.from([0, 0, 1]))).toBe(false);
    expect(hasNonZeroByte(Buffer.from([0, 0, 1]))).toBe(true);
  });
});

describe("isEmptyOrSilentStreamPayload", () => {
  it("treats a short or silent stream as empty", () => {
    expect(isEmptyOrSilentStreamPayload(0, false)).toBe(true);
    expect(isEmptyOrSilentStreamPayload(10_000, false)).toBe(true);
    expect(isEmptyOrSilentStreamPayload(10, true)).toBe(true);
  });

  it("accepts a stream with enough audible bytes", () => {
    expect(isEmptyOrSilentStreamPayload(10_000, true)).toBe(false);
  });
});
