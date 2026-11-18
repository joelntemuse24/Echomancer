import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MASTER_LOUDNORM_I,
  MASTER_LOUDNORM_TP,
  MODAL_S2_MASTERING,
  masterProfessionalAf,
  masterS2Af,
} from "./mastering";
import {
  VOICE_EQ_BANDS,
  VOICE_EQ_SAMPLE_RATE,
  voiceEqAf,
  voiceEqEnabled,
  voiceEqStageAf,
} from "./voice-eq";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const CENTRE_GAIN: Record<number, number> = {
  63: -4,
  125: -2,
  250: 0,
  500: 1,
  1000: 2,
  2000: 3,
  4000: 1,
  8000: -3,
  16000: -4,
};

function meanVolumeDb(af: string, frequency: number, sampleRate: number): number {
  const filter = af ? `${af},volumedetect` : "volumedetect";
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=${sampleRate}:duration=0.8`,
      "-af",
      filter,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" }
  );
  expect(result.status, result.stderr).toBe(0);
  const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(result.stderr);
  expect(match, result.stderr).toBeTruthy();
  return Number(match![1]);
}

function measureDelivery(af: string): { integrated: number; truePeak: number } {
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:sample_rate=44100:duration=8,highpass=f=100,lowpass=f=8000,volume=0.4",
      "-ac",
      "1",
      "-af",
      af,
      "-ar",
      "44100",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { maxBuffer: 8_000_000 }
  );
  expect(encoded.status, encoded.stderr?.toString()).toBe(0);
  const measured = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", "pipe:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
    { input: encoded.stdout, encoding: "utf8" }
  );
  expect(measured.status, measured.stderr).toBe(0);
  const integrated = measured.stderr.match(
    /Integrated loudness:[\s\S]*?I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/
  );
  const truePeak = measured.stderr.match(
    /True peak:[\s\S]*?Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/
  );
  expect(integrated, measured.stderr).toBeTruthy();
  expect(truePeak, measured.stderr).toBeTruthy();
  return {
    integrated: Number(integrated![1]),
    truePeak: Number(truePeak![1]),
  };
}

describe("voice EQ config", () => {
  it("lists the curve once, omits the 0 dB band, and defaults on", () => {
    expect(voiceEqEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(voiceEqEnabled({ TTS_VOICE_EQ: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(voiceEqEnabled({ TTS_VOICE_EQ: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(voiceEqEnabled({ TTS_VOICE_EQ: "1" } as NodeJS.ProcessEnv)).toBe(true);
    const centres = VOICE_EQ_BANDS.map((band) => band.centreHz);
    expect(centres).toEqual([63, 125, 500, 1000, 2000, 4000, 8000, 16000]);
    expect(VOICE_EQ_BANDS.map((band) => band.gainDb)).toEqual([
      -4, -2, 1, 2, 3, 1, -3, -4,
    ]);
    expect(VOICE_EQ_BANDS[0]?.kind).toBe("lowshelf");
    expect(VOICE_EQ_BANDS.at(-1)?.kind).toBe("highshelf");
    expect(voiceEqAf()).toContain("lowshelf=");
    expect(voiceEqAf()).toContain("highshelf=");
    expect(voiceEqAf()).toContain("equalizer=f=1000");
    expect(voiceEqAf()).not.toContain("f=250");
    expect(voiceEqAf({ TTS_VOICE_EQ: "0" })).toBe("");
    expect(voiceEqStageAf()).toBe(`aresample=${VOICE_EQ_SAMPLE_RATE},${voiceEqAf()}`);
    expect(voiceEqStageAf({ TTS_VOICE_EQ: "0" })).toBe("");
  });

  it("leaves the join and the loudnorm-only concat without the curve", () => {
    const root = process.cwd();
    const sectionMaster = readFileSync(
      path.join(root, "src/lib/tts/section-master.ts"),
      "utf8"
    );
    const encodeStart = sectionMaster.indexOf("async function encodePcmToMp3");
    const encodeEnd = sectionMaster.indexOf("async function", encodeStart + 10);
    const encode = sectionMaster.slice(encodeStart, encodeEnd);
    expect(encode).not.toContain("-af");
    expect(encode).not.toContain("voiceEq");
    expect(encode).not.toContain("loudnorm");

    const concat = readFileSync(path.join(root, "src/lib/tts/concat-audio.ts"), "utf8");
    const join = concat.slice(
      concat.indexOf('if (mode === "join")'),
      concat.indexOf('if (mode === "loudnorm")')
    );
    expect(join).toContain("encode(null");
    expect(join).not.toContain("voiceEq");
    const loudnormAt = concat.indexOf('if (mode === "loudnorm")');
    const loudnormOnly = concat.slice(loudnormAt, concat.indexOf("try {", loudnormAt));
    expect(loudnormOnly).toContain("masterLoudnormAf()");
    expect(loudnormOnly).not.toContain("voiceEq");
    expect(loudnormOnly).not.toContain("masterProfessionalAf");
  });
});

describe("voice EQ response", () => {
  it.skipIf(!hasFfmpeg)("hits each band centre within 1 dB", () => {
    const stage = voiceEqStageAf();
    const dry = new Map<number, number>();
    for (const frequency of Object.keys(CENTRE_GAIN).map(Number)) {
      dry.set(frequency, meanVolumeDb("", frequency, VOICE_EQ_SAMPLE_RATE));
    }
    for (const [frequency, target] of Object.entries(CENTRE_GAIN)) {
      const gain =
        meanVolumeDb(stage, Number(frequency), VOICE_EQ_SAMPLE_RATE) -
        dry.get(Number(frequency))!;
      expect(Math.abs(gain - target), `${frequency} Hz measured ${gain.toFixed(2)}`).toBeLessThanOrEqual(1);
    }
    // A 24 kHz provider file has no 16 kHz. The stage resamples first, so
    // the 8 kHz centre still matches the 44.1 kHz curve.
    const dry8 = meanVolumeDb("", 8000, 24_000);
    const wet8 = meanVolumeDb(stage, 8000, 24_000);
    const at44 = meanVolumeDb(stage, 8000, VOICE_EQ_SAMPLE_RATE) - dry.get(8000)!;
    expect(Math.abs(wet8 - dry8 - at44)).toBeLessThanOrEqual(0.4);
  });

  it.skipIf(!hasFfmpeg)(
    "keeps the loudness target and true peak of both mastering chains",
    () => {
      const off = { TTS_VOICE_EQ: "0" } as NodeJS.ProcessEnv;
      const podcastOn = measureDelivery(masterProfessionalAf());
      const podcastOff = measureDelivery(masterProfessionalAf(off));
      for (const reading of [podcastOn, podcastOff]) {
        expect(reading.integrated).toBeGreaterThan(MASTER_LOUDNORM_I - 1.5);
        expect(reading.integrated).toBeLessThan(MASTER_LOUDNORM_I + 1.5);
        expect(reading.truePeak).toBeLessThanOrEqual(-1);
      }
      expect(Math.abs(podcastOn.integrated - podcastOff.integrated)).toBeLessThanOrEqual(1);
      expect(Math.abs(podcastOn.truePeak - podcastOff.truePeak)).toBeLessThanOrEqual(1);

      const s2On = measureDelivery(masterS2Af());
      const s2Off = measureDelivery(masterS2Af(off));
      for (const reading of [s2On, s2Off]) {
        expect(reading.integrated).toBeGreaterThan(MODAL_S2_MASTERING.loudnormI - 1.5);
        expect(reading.integrated).toBeLessThan(MODAL_S2_MASTERING.loudnormI + 1.5);
        expect(reading.truePeak).toBeLessThanOrEqual(MASTER_LOUDNORM_TP);
      }
      expect(Math.abs(s2On.integrated - s2Off.integrated)).toBeLessThanOrEqual(1);
      expect(Math.abs(s2On.truePeak - s2Off.truePeak)).toBeLessThanOrEqual(1);
    }
  );
});
