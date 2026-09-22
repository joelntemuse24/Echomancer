import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MASTER_LOUDNORM_I, masterProfessionalAf } from "./mastering";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

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
      "192k",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { maxBuffer: 8_000_000 }
  );
  expect(encoded.status, encoded.stderr?.toString()).toBe(0);
  const measured = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      "pipe:0",
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
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

describe("delivery loudness smoke", () => {
  it.skipIf(!hasFfmpeg)(
    "lands near -16 LUFS with true peak at or under -1 dBTP",
    () => {
      const { integrated, truePeak } = measureDelivery(masterProfessionalAf());
      expect(integrated).toBeGreaterThan(MASTER_LOUDNORM_I - 1.5);
      expect(integrated).toBeLessThan(MASTER_LOUDNORM_I + 1.5);
      expect(truePeak).toBeLessThanOrEqual(-1);
    }
  );
});
