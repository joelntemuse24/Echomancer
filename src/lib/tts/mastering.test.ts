import { afterEach, describe, expect, it, vi } from "vitest";
import { pcmToWav } from "./pcm-wav";
import { fakeMp3 } from "@/test/harness";
import {
  MASTER_BLEND_DRY,
  MASTER_BLEND_ENHANCED,
  MASTER_LOUDNORM_I,
  MASTER_LOUDNORM_TP,
  MASTER_MIN_DURATION_SECONDS,
  applyFullBookMastering,
  estimateAudioDurationSeconds,
  masterBlendFilterComplex,
  shouldAttemptMastering,
} from "./mastering";

const MP3 = { extension: "mp3" as const, contentType: "audio/mpeg" };
const WAV = { extension: "wav" as const, contentType: "audio/wav" };

const ENV_KEYS = [
  "VERCEL",
  "TRIGGER",
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

describe("mastering constants", () => {
  it("uses Joel's 70/30 blend and loudnorm targets", () => {
    expect(MASTER_BLEND_ENHANCED).toBe(0.7);
    expect(MASTER_BLEND_DRY).toBe(0.3);
    expect(MASTER_BLEND_ENHANCED + MASTER_BLEND_DRY).toBeCloseTo(1);
    expect(MASTER_LOUDNORM_I).toBe(-18);
    expect(MASTER_LOUDNORM_TP).toBe(-1.5);
    expect(MASTER_MIN_DURATION_SECONDS).toBeGreaterThan(0);
    const graph = masterBlendFilterComplex();
    expect(graph).toContain(`volume=${MASTER_BLEND_ENHANCED}`);
    expect(graph).toContain(`volume=${MASTER_BLEND_DRY}`);
    expect(graph).toContain(`I=${MASTER_LOUDNORM_I}`);
    expect(graph).toContain(`TP=${MASTER_LOUDNORM_TP}`);
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
