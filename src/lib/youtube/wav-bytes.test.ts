import { describe, expect, it } from "vitest";
import { floatToWavBytes } from "./wav-bytes";

describe("floatToWavBytes", () => {
  it("writes a mono 16-bit wav header", () => {
    const wav = floatToWavBytes(new Float32Array([0, 0.5, -0.5]), 44100);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + 6);
  });
});
