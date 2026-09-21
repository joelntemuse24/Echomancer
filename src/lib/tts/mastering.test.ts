import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pcmToWav } from "./pcm-wav";
import { fakeMp3 } from "@/test/harness";
import {
  MASTER_BLEND_DRY,
  MASTER_BLEND_ENHANCED,
  MASTER_LOUDNORM_I,
  MASTER_LOUDNORM_LRA,
  MASTER_LOUDNORM_TP,
  MASTER_MIN_DURATION_SECONDS,
  MASTER_OUTPUT_MP3_BITRATE,
  MASTER_OUTPUT_SAMPLE_RATE,
  applyFullBookMastering,
  estimateAudioDurationSeconds,
  masterBlendFilterComplex,
  masterDenoiseWet,
  masterEncodeArgs,
  masterProfessionalAf,
  shouldAttemptMastering,
} from "./mastering";

const MP3 = { extension: "mp3" as const, contentType: "audio/mpeg" };
const WAV = { extension: "wav" as const, contentType: "audio/wav" };

const ENV_KEYS = [
  "VERCEL",
  "TRIGGER",
  "WORKER",
  "TTS_MASTER_SKIP",
  "TTS_MASTER_FULL_BOOK",
  "DEEP_FILTER_BIN",
] as const;

const saved: Record<string, string | undefined> = {};

function snapshotEnv() {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

snapshotEnv();

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("mastering constants", () => {
  it("defaults DFN off, keeps EBU loudnorm, and encodes 44.1 kHz ~192 kbps", () => {
    expect(MASTER_BLEND_ENHANCED).toBe(0.4);
    expect(MASTER_BLEND_DRY).toBe(0.6);
    expect(MASTER_BLEND_ENHANCED + MASTER_BLEND_DRY).toBeCloseTo(1);
    expect(MASTER_LOUDNORM_I).toBe(-18);
    expect(MASTER_LOUDNORM_TP).toBe(-1.5);
    expect(MASTER_LOUDNORM_LRA).toBe(11);
    expect(MASTER_MIN_DURATION_SECONDS).toBeGreaterThan(0);
    expect(MASTER_OUTPUT_SAMPLE_RATE).toBe(44_100);
    expect(MASTER_OUTPUT_MP3_BITRATE).toBe("192k");
    const graph = masterBlendFilterComplex();
    expect(graph).toContain(`volume=${MASTER_BLEND_ENHANCED}`);
    expect(graph).toContain(`volume=${MASTER_BLEND_DRY}`);
    expect(graph).toContain(`I=${MASTER_LOUDNORM_I}`);
    expect(graph).toContain(`TP=${MASTER_LOUDNORM_TP}`);
    expect(graph).toContain(`LRA=${MASTER_LOUDNORM_LRA}`);
    expect(graph).toContain("highpass=f=70");
    const mp3 = masterEncodeArgs(MP3);
    expect(mp3).toEqual(
      expect.arrayContaining(["-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k"])
    );
  });

  it("uses a phone Smooth EQ: rumble kill, low-mid lift, high cut, loudnorm", () => {
    const af = masterProfessionalAf();
    expect(af).toContain("highpass=f=70");
    expect(af).toMatch(/equalizer=f=200:width_type=o:width=1\.8:g=3\.2/);
    expect(af).toMatch(/equalizer=f=450:width_type=o:width=1\.0:g=1\.5/);
    expect(af).toMatch(/equalizer=f=8000:width_type=o:width=1\.2:g=-3/);
    expect(af).toMatch(/equalizer=f=14000:width_type=h:width=4000:g=-4\.5/);
    expect(af).toContain(
      `loudnorm=I=${MASTER_LOUDNORM_I}:TP=${MASTER_LOUDNORM_TP}:LRA=${MASTER_LOUDNORM_LRA}`
    );
    expect(af).not.toContain("f=6500");
    expect(masterBlendFilterComplex()).toContain(af);
  });

  it.skipIf(!hasFfmpeg)("ffmpeg accepts the Smooth filter graph", () => {
    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono",
        "-t",
        "0.25",
        "-af",
        masterProfessionalAf(),
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" }
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("skips DeepFilter by default and only opts in via env", () => {
    expect(masterDenoiseWet({} as NodeJS.ProcessEnv)).toBe(0);
    expect(masterDenoiseWet({ TTS_MASTER_DFN: "1" } as NodeJS.ProcessEnv)).toBe(
      MASTER_BLEND_ENHANCED
    );
    expect(
      masterDenoiseWet({ TTS_MASTER_DFN_WET: "0.25" } as NodeJS.ProcessEnv)
    ).toBe(0.25);
    expect(
      masterDenoiseWet({
        TTS_MASTER_DFN: "1",
        TTS_MASTER_DFN_WET: "0",
      } as NodeJS.ProcessEnv)
    ).toBe(0);
    expect(masterDenoiseWet({ TTS_MASTER_DFN_WET: "9" } as NodeJS.ProcessEnv)).toBe(
      0
    );
    expect(
      masterDenoiseWet({
        TTS_MASTER_DFN: "1",
        TTS_MASTER_DFN_WET: "nope",
      } as NodeJS.ProcessEnv)
    ).toBe(MASTER_BLEND_ENHANCED);
  });
});

describe("shouldAttemptMastering", () => {
  it("never runs on the Vercel isolate, even if Trigger flags leak in", () => {
    process.env.VERCEL = "1";
    process.env.TRIGGER = "1";
    process.env.TTS_MASTER_FULL_BOOK = "1";
    expect(shouldAttemptMastering()).toBe(false);
  });

  it("runs on the Trigger worker", () => {
    delete process.env.VERCEL;
    process.env.TRIGGER = "1";
    expect(shouldAttemptMastering()).toBe(true);
  });

  it("runs on the always-on VM worker", () => {
    delete process.env.VERCEL;
    delete process.env.TRIGGER;
    process.env.WORKER = "1";
    expect(shouldAttemptMastering()).toBe(true);
  });

  it("honors skip and local opt-in flags", () => {
    delete process.env.VERCEL;
    process.env.TRIGGER = "1";
    process.env.TTS_MASTER_SKIP = "1";
    expect(shouldAttemptMastering()).toBe(false);

    delete process.env.TTS_MASTER_SKIP;
    delete process.env.TRIGGER;
    process.env.TTS_MASTER_FULL_BOOK = "1";
    expect(shouldAttemptMastering()).toBe(true);
  });

  it("treats DEEP_FILTER_BIN as the Trigger deploy signal", () => {
    delete process.env.VERCEL;
    delete process.env.TRIGGER;
    delete process.env.TTS_MASTER_FULL_BOOK;
    process.env.DEEP_FILTER_BIN = "/usr/local/bin/deep-filter";
    expect(shouldAttemptMastering()).toBe(true);

    process.env.VERCEL = "1";
    expect(shouldAttemptMastering()).toBe(false);
    delete process.env.DEEP_FILTER_BIN;
  });
});

describe("estimateAudioDurationSeconds", () => {
  it("reads WAV duration from the PCM data chunk", () => {
    const pcm = Buffer.alloc(24_000 * 2 * 3); // 3s @ 24 kHz mono 16-bit
    const wav = pcmToWav(pcm, { sampleRate: 24_000 });
    expect(estimateAudioDurationSeconds(wav, WAV)).toBeCloseTo(3, 2);
  });

  it("treats a short MP3 as shorter than the master floor", () => {
    const tiny = fakeMp3(512);
    const seconds = estimateAudioDurationSeconds(tiny, MP3);
    expect(seconds).not.toBeNull();
    expect(seconds!).toBeLessThan(MASTER_MIN_DURATION_SECONDS);
  });
});

describe("applyFullBookMastering fail-open", () => {
  it("returns the original bytes when enhance throws", async () => {
    const original = fakeMp3(64_000);
    const enhance = vi.fn(async () => {
      throw new Error("deep-filter crashed");
    });

    const result = await applyFullBookMastering(original, MP3, { enhance });

    expect(enhance).toHaveBeenCalledOnce();
    expect(result.mastered).toBe(false);
    expect(result.reason).toBe("failed-open");
    expect(result.buffer.equals(original)).toBe(true);
  });

  it("skips enhance for tiny audio and for an already-mastered flag", async () => {
    const enhance = vi.fn(async () => Buffer.from("enhanced"));

    const tiny = await applyFullBookMastering(fakeMp3(512), MP3, { enhance });
    expect(enhance).not.toHaveBeenCalled();
    expect(tiny.reason).toBe("too-short");
    expect(tiny.mastered).toBe(false);

    const longEnough = fakeMp3(64_000);
    const flagged = await applyFullBookMastering(longEnough, MP3, {
      enhance,
      alreadyMastered: true,
    });
    expect(enhance).not.toHaveBeenCalled();
    expect(flagged.reason).toBe("already-mastered");
    expect(flagged.buffer.equals(longEnough)).toBe(true);
  });

  it("returns enhanced bytes when the worker succeeds", async () => {
    const original = fakeMp3(64_000);
    const mastered = Buffer.from("70-30-loudnorm");
    const result = await applyFullBookMastering(original, MP3, {
      enhance: async () => mastered,
    });
    expect(result.mastered).toBe(true);
    expect(result.buffer.equals(mastered)).toBe(true);
  });
});
