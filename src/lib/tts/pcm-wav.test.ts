import { describe, expect, it } from "vitest";
import {
  createWavHeader,
  ensureBrowserPlayable,
  isRawPcmContentType,
  pcmToWav,
  sampleRateFromContentType,
  stripWavHeader,
} from "./pcm-wav";

describe("pcm-wav", () => {
  it("detects raw PCM content types", () => {
    expect(isRawPcmContentType("audio/pcm")).toBe(true);
    expect(isRawPcmContentType("audio/L16;rate=24000")).toBe(true);
    expect(isRawPcmContentType("audio/mpeg")).toBe(false);
  });

  it("parses sample rate from mime", () => {
    expect(sampleRateFromContentType("audio/L16;rate=24000")).toBe(24000);
    expect(sampleRateFromContentType("audio/pcm")).toBe(24000);
  });

  it("wraps PCM in a valid WAV header", () => {
    const pcm = Buffer.alloc(4800); // 100ms @ 24kHz mono 16-bit
    const wav = pcmToWav(pcm, { sampleRate: 24000 });
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(4800);
    expect(wav.length).toBe(44 + 4800);
    expect(wav.readUInt32LE(24)).toBe(24000);
  });

  it("ensureBrowserPlayable converts PCM and leaves MP3 alone", () => {
    const pcm = Buffer.from([0, 1, 2, 3]);
    const converted = ensureBrowserPlayable(pcm, "audio/pcm");
    expect(converted.contentType).toBe("audio/wav");
    expect(converted.audio.length).toBe(48);

    const mp3 = Buffer.from([0xff, 0xfb]);
    const same = ensureBrowserPlayable(mp3, "audio/mpeg");
    expect(same.contentType).toBe("audio/mpeg");
    expect(same.audio).toBe(mp3);
  });

  it("strips WAV header for concatenation", () => {
    const pcm = Buffer.from([10, 20, 30, 40]);
    const wav = pcmToWav(pcm);
    expect(stripWavHeader(wav).equals(pcm)).toBe(true);
    expect(stripWavHeader(pcm).equals(pcm)).toBe(true);
  });

  it("createWavHeader supports streaming-sized estimates", () => {
    const header = createWavHeader(0x7fffffff);
    expect(header.length).toBe(44);
    expect(header.readUInt32LE(40)).toBe(0x7fffffff);
  });
});
