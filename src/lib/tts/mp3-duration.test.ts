import { describe, expect, it } from "vitest";
import { mp3DeclaredDurationSeconds, mp3DurationSeconds } from "./mp3-duration";

const SAMPLE_RATE = 44100;
const SAMPLES = 1152;

/** MPEG1 Layer III, 128 kbps, 44.1 kHz, mono. One frame is 417 bytes. */
function audioFrame(): Buffer {
  const length = Math.floor((SAMPLES * 128_000) / (8 * SAMPLE_RATE));
  const frame = Buffer.alloc(length, 0);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0xc0;
  return frame;
}

function infoFrame(frames: number): Buffer {
  const frame = audioFrame();
  frame.write("Info", 21, "ascii");
  frame.writeUInt32BE(0x00000001, 25);
  frame.writeUInt32BE(frames, 29);
  return frame;
}

function id3(padding: number): Buffer {
  const header = Buffer.alloc(10, 0);
  header.write("ID3", 0, "ascii");
  header[3] = 3;
  header[9] = padding & 0x7f;
  return Buffer.concat([header, Buffer.alloc(padding, 0)]);
}

describe("mp3DurationSeconds", () => {
  it("sums frame durations and ignores a leading ID3 tag", () => {
    const audio = Buffer.concat([id3(64), audioFrame(), audioFrame(), audioFrame()]);
    const seconds = mp3DurationSeconds(audio);
    expect(seconds).toBeCloseTo((3 * SAMPLES) / SAMPLE_RATE, 6);
    const bitrateGuess = (audio.length * 8) / 128_000;
    expect(bitrateGuess).toBeGreaterThan(seconds! + 0.001);
  });

  it("reads a Xing or Info frame count without walking the rest of the file", () => {
    const audio = infoFrame(100);
    expect(mp3DeclaredDurationSeconds(audio)).toBeCloseTo((100 * SAMPLES) / SAMPLE_RATE, 6);
    expect(mp3DurationSeconds(audio)).toBeCloseTo((100 * SAMPLES) / SAMPLE_RATE, 6);
  });

  it("does not treat a short prefix as the whole file when no frame count is declared", () => {
    expect(mp3DeclaredDurationSeconds(audioFrame())).toBeNull();
  });
});
