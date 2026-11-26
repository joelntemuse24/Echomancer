import { describe, expect, it } from "vitest";
import { masterLoudnormAf } from "@/lib/tts/mastering";
import {
  KOKORO_BUNDLE_CONTENT_TYPE,
  kokoroContainerMasterEnabled,
  kokoroMasterRecipe,
  parseKokoroBody,
} from "@/lib/tts/kokoro-master";

function wav(bytes = 80): Buffer {
  const pcm = Buffer.alloc(bytes, 1);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe("kokoro container mastering", () => {
  it("is off unless the worker asks for it", () => {
    expect(kokoroContainerMasterEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      kokoroContainerMasterEnabled({
        KOKORO_CONTAINER_MASTER: "1",
        TTS_SECTION_MASTER: "0",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("builds the same loudnorm string the section master uses", () => {
    const recipe = kokoroMasterRecipe();
    expect(recipe.measureAf).toContain(`${masterLoudnormAf()}:print_format=json`);
    expect(recipe.loudnorm).toBe(masterLoudnormAf());
    expect(recipe.sampleRate).toBe(44100);
    expect(recipe.bitrate).toBe("128k");
    expect(recipe.shortSeconds).toBeGreaterThan(0);
  });

  it("returns a plain wav body unchanged", () => {
    const body = wav();
    const headers = new Headers({ "content-type": "audio/wav" });
    expect(parseKokoroBody(body, headers)).toEqual({ wav: body });
  });

  it("splits a bundle by the length headers", () => {
    const mp3 = Buffer.from("mp3-bytes");
    const audio = wav();
    const body = Buffer.concat([mp3, audio]);
    const headers = new Headers({
      "content-type": KOKORO_BUNDLE_CONTENT_TYPE,
      "x-kokoro-mp3-bytes": String(mp3.length),
      "x-kokoro-wav-bytes": String(audio.length),
    });
    const take = parseKokoroBody(body, headers);
    expect(take.mastered?.equals(mp3)).toBe(true);
    expect(take.wav.equals(audio)).toBe(true);
  });

  it("refuses a bundle whose lengths do not add up", () => {
    const headers = new Headers({
      "content-type": `${KOKORO_BUNDLE_CONTENT_TYPE}; charset=binary`,
      "x-kokoro-mp3-bytes": "4",
      "x-kokoro-wav-bytes": "4",
    });
    expect(() => parseKokoroBody(Buffer.alloc(20), headers)).toThrow(/lengths do not match/);
  });
});
