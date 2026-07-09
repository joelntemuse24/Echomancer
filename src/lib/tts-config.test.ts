import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isShortTtsJob,
  resolveMossBatchUrl,
  resolveTtsRoute,
} from "./tts-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hybrid TTS routing", () => {
  it("routes previews to SGLang regardless of the audiobook override", () => {
    vi.stubEnv("MOSS_AB_VARIANT", "delay");

    expect(resolveTtsRoute("preview").variant).toBe("sglang");
  });

  it("routes single-batch audiobooks to SGLang", () => {
    vi.stubEnv("MOSS_AB_VARIANT", "delay");

    expect(
      resolveTtsRoute("audiobook", { charCount: 2500, paragraphCount: 8 }).variant
    ).toBe("sglang");
  });

  it("routes full audiobooks to Delay by default", () => {
    vi.stubEnv("MOSS_AB_VARIANT", "");

    expect(
      resolveTtsRoute("audiobook", { charCount: 2501, paragraphCount: 2 }).variant
    ).toBe("delay");
  });

  it("honors the audiobook variant override for full books", () => {
    vi.stubEnv("MOSS_AB_VARIANT", "sglang");

    expect(
      resolveTtsRoute("audiobook", { charCount: 100_000, paragraphCount: 50 }).variant
    ).toBe("sglang");
  });

  it("keeps retries on their persisted variant when thresholds change", () => {
    vi.stubEnv("MOSS_SHORT_JOB_CHAR_THRESHOLD", "10000");

    expect(
      resolveTtsRoute("audiobook", { charCount: 5000 }, "delay").variant
    ).toBe("delay");
  });

  it("uses a configurable short-job threshold", () => {
    vi.stubEnv("MOSS_SHORT_JOB_CHAR_THRESHOLD", "5000");

    expect(isShortTtsJob({ charCount: 4999 })).toBe(true);
    expect(isShortTtsJob({ charCount: 5001 })).toBe(false);
  });

  it("resolves the dedicated Delay URL before legacy fallbacks", () => {
    vi.stubEnv("MODAL_MOSS_DELAY_TTS_URL", "https://delay.example/generate_batch");
    vi.stubEnv("MODAL_MOSS_TTS_URL", "https://legacy.example/generate_batch");

    expect(resolveMossBatchUrl("delay")).toBe(
      "https://delay.example/generate_batch"
    );
  });

  it("does not misroute full Delay jobs through the generic preview URL", () => {
    vi.stubEnv("MODAL_TTS_URL", "https://sglang.example/generate_batch");
    vi.stubEnv("MODAL_MOSS_TTS_URL", "");
    vi.stubEnv("MODAL_MOSS_DELAY_TTS_URL", "");

    expect(
      resolveTtsRoute("audiobook", { charCount: 50_000 }, "delay").batchUrl
    ).toBeUndefined();
  });
});
