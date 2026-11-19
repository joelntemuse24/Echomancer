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
  masterLoudnormAf,
  MODAL_S2_MASTERING,
  masterPodcastFiltersAf,
  masterPreLoudnormAf,
  masterProfessionalAf,
  masterProfessionalLinearAf,
  planSectionLoudness,
  SHORT_SECTION_MASTER_SECONDS,
  shortSectionApplyAf,
  shortSectionGainDb,
  masterProfessionalMeasureAf,
  masterS2Af,
  masterS2LinearAf,
  masterS2LoudnormAf,
  masterS2MeasureAf,
  parseLoudnormProbe,
  shouldAttemptMastering,
} from "./mastering";
import { voiceEqStageAf } from "./voice-eq";

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
  it("defaults DFN off, keeps EBU loudnorm, and encodes 44.1 kHz mono 128 kbps", () => {
    expect(MASTER_BLEND_ENHANCED).toBe(0.4);
    expect(MASTER_BLEND_DRY).toBe(0.6);
    expect(MASTER_BLEND_ENHANCED + MASTER_BLEND_DRY).toBeCloseTo(1);
    expect(MASTER_LOUDNORM_I).toBe(-16);
    expect(MASTER_LOUDNORM_TP).toBe(-1.5);
    expect(MASTER_LOUDNORM_LRA).toBe(11);
    expect(MASTER_MIN_DURATION_SECONDS).toBeGreaterThan(0);
    expect(MASTER_OUTPUT_SAMPLE_RATE).toBe(44_100);
    expect(MASTER_OUTPUT_MP3_BITRATE).toMatch(/^\d{2,3}k$/);
    const graph = masterBlendFilterComplex();
    expect(graph).toContain(`volume=${MASTER_BLEND_ENHANCED}`);
    expect(graph).toContain(`volume=${MASTER_BLEND_DRY}`);
    expect(graph).toContain(`I=${MASTER_LOUDNORM_I}`);
    expect(graph).toContain(`TP=${MASTER_LOUDNORM_TP}`);
    expect(graph).toContain(`LRA=${MASTER_LOUDNORM_LRA}`);
    expect(graph).toContain("highpass=f=80");
    expect(graph).toContain("deesser=");
    expect(SHORT_SECTION_MASTER_SECONDS).toBe(3);
    expect(planSectionLoudness(2.9)).toBe("short-gain");
    expect(planSectionLoudness(3)).toBe("two-pass");
    expect(planSectionLoudness(null)).toBe("two-pass");
    const short = shortSectionApplyAf(shortSectionGainDb(-30, MASTER_LOUDNORM_I), MASTER_LOUDNORM_TP);
    expect(short).not.toContain("loudnorm");
    expect(short).not.toContain("linear=true");
    expect(short).toContain("alimiter=");
    expect(short).toContain("level=false");
    expect(shortSectionGainDb(-80, -16)).toBe(24);
    expect(shortSectionGainDb(-10, -16)).toBe(-6);
    const pre = masterPreLoudnormAf("podcast");
    expect(pre).not.toContain("loudnorm");
    expect(pre).toContain("highpass=f=80");
    expect(masterProfessionalLinearAf({
      input_i: -24,
      input_tp: -3,
      input_lra: 4,
      input_thresh: -34,
      target_offset: 0,
    })).toContain("linear=true");
    const mp3 = masterEncodeArgs(MP3);
    expect(mp3).toEqual(
      expect.arrayContaining([
        "-b:a",
        MASTER_OUTPUT_MP3_BITRATE,
      ])
    );
  });

  it("keeps the delivery encode at 128k by default", () => {
    expect(masterEncodeArgs(MP3)).toEqual(
      expect.arrayContaining([
        "-ar",
        "44100",
        "-ac",
        "1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        MASTER_OUTPUT_MP3_BITRATE,
      ])
    );
  });

  it("defaults the delivery bitrate to 128k", async () => {
    vi.resetModules();
    vi.stubEnv("AUDIOBOOK_BITRATE", "");
    try {
      const mod = await import("./mastering");
      expect(mod.MASTER_OUTPUT_MP3_BITRATE).toBe("128k");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads AUDIOBOOK_BITRATE when it is a valid bitrate", async () => {
    vi.resetModules();
    vi.stubEnv("AUDIOBOOK_BITRATE", "96k");
    try {
      const mod = await import("./mastering");
      expect(mod.MASTER_OUTPUT_MP3_BITRATE).toBe("96k");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores an invalid AUDIOBOOK_BITRATE", async () => {
    vi.resetModules();
    vi.stubEnv("AUDIOBOOK_BITRATE", "96");
    try {
      const mod = await import("./mastering");
      expect(mod.MASTER_OUTPUT_MP3_BITRATE).toBe("128k");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads a loudnorm measurement and builds the linear second pass", () => {
    const probe = parseLoudnormProbe(
      'before {\n\t"input_i" : "-20.89",\n\t"input_tp" : "-2.76",\n\t"input_lra" : "0.40",\n\t"input_thresh" : "-31.36",\n\t"target_offset" : "0.75"\n}\n'
    );
    expect(probe?.input_i).toBeCloseTo(-20.89);
    expect(probe?.target_offset).toBeCloseTo(0.75);
    expect(parseLoudnormProbe("no json")).toBeNull();
    const af = masterProfessionalLinearAf(probe!);
    expect(af).toContain("measured_I=-20.89");
    expect(af).toContain("offset=0.75");
    expect(af).toContain("linear=true");
    expect(af).toContain("highpass=f=80");
  });

  it("uses a podcast chain: high-pass, de-mud, presence, light de-ess, loudnorm", () => {
    const filters = masterPodcastFiltersAf();
    const af = masterProfessionalAf();
    expect(filters).toContain("highpass=f=80:poles=2");
    expect(filters).toMatch(/equalizer=f=280:width_type=o:width=1\.4:g=-1\.8/);
    expect(filters).toMatch(/equalizer=f=3400:width_type=o:width=1\.2:g=1\.6/);
    expect(filters).toContain("deesser=i=0.4:m=0.5:f=0.5:s=o");
    expect(filters).not.toContain("acompressor");
    expect(filters).not.toContain("f=8000");
    const stage = voiceEqStageAf();
    expect(af).toBe(`${filters},${stage},${masterLoudnormAf()}`);
    expect(af.indexOf(stage)).toBeGreaterThan(af.indexOf("deesser"));
    expect(af.indexOf("loudnorm=")).toBeGreaterThan(af.indexOf(stage));
    expect(af).not.toContain("g=3.2");
    expect(af).not.toContain("f=14000");
    expect(masterProfessionalAf({ TTS_VOICE_EQ: "0" })).toBe(
      `${filters},${masterLoudnormAf()}`
    );
    const measured = masterProfessionalMeasureAf();
    expect(measured.indexOf(stage)).toBeLessThan(measured.indexOf("loudnorm="));
    expect(measured).toContain("print_format=json");
    const linear = masterProfessionalLinearAf({
      input_i: -20,
      input_tp: -2,
      input_lra: 4,
      input_thresh: -30,
      target_offset: 0.5,
    });
    expect(linear.indexOf(stage)).toBeLessThan(linear.indexOf("loudnorm="));
    expect(linear).toContain("linear=true");
    const s2 = masterS2Af();
    expect(s2.indexOf(stage)).toBeLessThan(s2.indexOf("loudnorm="));
    expect(s2).toContain(masterS2LoudnormAf());
    expect(masterS2Af({ TTS_VOICE_EQ: "0" })).toBe(
      `${MODAL_S2_MASTERING.spectralAf},${masterS2LoudnormAf()}`
    );
    expect(masterS2MeasureAf().indexOf(stage)).toBeLessThan(
      masterS2MeasureAf().indexOf("loudnorm=")
    );
    expect(
      masterS2LinearAf({
        input_i: -23,
        input_tp: -4,
        input_lra: 5,
        input_thresh: -33,
        target_offset: 0.2,
      }).indexOf(stage)
    ).toBeLessThan(
      masterS2LinearAf({
        input_i: -23,
        input_tp: -4,
        input_lra: 5,
        input_thresh: -33,
        target_offset: 0.2,
      }).indexOf("loudnorm=")
    );
    expect(masterBlendFilterComplex()).toContain(af);
  });

  it.skipIf(!hasFfmpeg)("ffmpeg accepts the podcast delivery filter graph", () => {
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
  it("never runs on the Vercel isolate", () => {
    process.env.VERCEL = "1";
    process.env.TTS_MASTER_FULL_BOOK = "1";
    expect(shouldAttemptMastering()).toBe(false);
  });

  it("does not treat a leftover host flag as the VM", () => {
    delete process.env.VERCEL;
    delete process.env.WORKER;
    delete process.env.TTS_MASTER_FULL_BOOK;
    delete process.env.DEEP_FILTER_BIN;
    process.env.TRIGGER = "1";
    expect(shouldAttemptMastering()).toBe(false);
    delete process.env.TRIGGER;
  });

  it("runs on the always-on VM worker", () => {
    delete process.env.VERCEL;
    process.env.WORKER = "1";
    expect(shouldAttemptMastering()).toBe(true);
  });

  it("honors skip and local opt-in flags", () => {
    delete process.env.VERCEL;
    process.env.WORKER = "1";
    process.env.TTS_MASTER_SKIP = "1";
    expect(shouldAttemptMastering()).toBe(false);

    delete process.env.TTS_MASTER_SKIP;
    delete process.env.WORKER;
    process.env.TTS_MASTER_FULL_BOOK = "1";
    expect(shouldAttemptMastering()).toBe(true);
  });

  it("treats DEEP_FILTER_BIN as a worker host signal", () => {
    delete process.env.VERCEL;
    delete process.env.WORKER;
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
