import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createWavHeader } from "@/lib/tts/pcm-wav";
import { audioDurationSeconds } from "@/lib/tts/mp3-duration";
import { MASTER_LOUDNORM_I, MODAL_S2_MASTERING } from "@/lib/tts/mastering";
import { masterSectionBuffer } from "@/lib/tts/section-master";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** A quiet 2.9 s tone. Short enough to take the single-gain path, long enough to measure. */
function shortToneWav(seconds = 2.9): Buffer {
  const sampleRate = 24_000;
  const n = Math.round(sampleRate * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const sample =
      0.08 * Math.sin(2 * Math.PI * 220 * t) +
      0.03 * Math.sin(2 * Math.PI * 1800 * t);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
  }
  return Buffer.concat([
    createWavHeader(pcm.length, { sampleRate, numChannels: 1, bitDepth: 16 }),
    pcm,
  ]);
}

function measureMp3(mp3: Buffer): { integrated: number; truePeak: number } {
  const measured = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-i", "pipe:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
    { input: mp3, encoding: "utf8" }
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
  return { integrated: Number(integrated![1]), truePeak: Number(truePeak![1]) };
}

describe("short section mastering", () => {
  it.skipIf(!hasFfmpeg)(
    "a 2.9s clip lands within 1.5 LU of the book target without linear loudnorm",
    async () => {
      const wav = shortToneWav(2.9);
      const duration = audioDurationSeconds(wav);
      expect(duration).toBeGreaterThan(2.8);
      expect(duration).toBeLessThan(3);
      const env = { ...process.env, TTS_SECTION_MASTER: "1" };
      const podcast = await masterSectionBuffer(wav, "wav", env, "podcast");
      expect(podcast).toBeTruthy();
      const podcastLevel = measureMp3(podcast!);
      expect(podcastLevel.integrated).toBeGreaterThan(MASTER_LOUDNORM_I - 1.5);
      expect(podcastLevel.integrated).toBeLessThan(MASTER_LOUDNORM_I + 1.5);
      expect(podcastLevel.truePeak).toBeLessThanOrEqual(-1);

      const s2 = await masterSectionBuffer(wav, "wav", env, "s2");
      expect(s2).toBeTruthy();
      const s2Level = measureMp3(s2!);
      expect(s2Level.integrated).toBeGreaterThan(MODAL_S2_MASTERING.loudnormI - 1.5);
      expect(s2Level.integrated).toBeLessThan(MODAL_S2_MASTERING.loudnormI + 1.5);
      expect(s2Level.truePeak).toBeLessThanOrEqual(MODAL_S2_MASTERING.loudnormTp + 0.5);
    }
  );
});
