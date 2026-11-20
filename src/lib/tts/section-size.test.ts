import { describe, expect, it } from "vitest";
import {
  FISH_EVEN_PACK_MIN_CHARS,
  FISH_HARD_MAX_CHARS,
  FISH_TARGET_CHARS,
  STREAM_WINDOW_CHARS,
  catalogMaxForStoredProvider,
  EDGE_GOOGLE_PACK_MIN_CHARS,
  edgeGoogleTakehomeTargetChars,
  evenTakehomeTargetChars,
  hardMaxCharsForModel,
  isKokoroCpuProvider,
  KOKORO_CPU_FIRST_SECTION_CHARS,
  KOKORO_CPU_REQUEST_MAX_CHARS,
  KOKORO_CPU_SECTION_CHARS_DEFAULT,
  KOKORO_CPU_SECTION_CHARS_MAX,
  KOKORO_CPU_SECTION_CHARS_MIN,
  kokoroCpuSectionChars,
  kokoroCpuSectionPlan,
  maxCharsForModel,
  streamWindowChars,
} from "./section-size";
import { GOOGLE_SSML_HARD_MAX_BYTES } from "./ssml-pauses";

describe("maxCharsForModel", () => {
  it("trusts the catalog value above every fallback", () => {
    expect(
      maxCharsForModel({ provider: "grok", model: "openai/tts", catalogMax: 111 })
    ).toBe(111);
  });

  it("ignores a nonsensical catalog value", () => {
    expect(maxCharsForModel({ model: "google/gemini-2.5-flash-tts", catalogMax: 0 })).toBe(
      3000
    );
  });

  it("uses per-model limits before per-provider ones", () => {
    expect(maxCharsForModel({ provider: "grok", model: "openai/gpt-4o-mini-tts" })).toBe(
      4000
    );
    expect(maxCharsForModel({ provider: "gemini", model: "google/gemini-2.5-flash-tts" })).toBe(
      3000
    );
  });

  it("keeps small-context models small", () => {
    expect(maxCharsForModel({ model: "zyphra/zonos-v0.1" })).toBe(350);
    expect(maxCharsForModel({ model: "hexgrad/kokoro" })).toBe(800);
  });

  it("uses the Fish ceiling when the stored provider differs from the catalog card", () => {
    const catalogMax = catalogMaxForStoredProvider({
      storedProvider: "fish",
      catalogProvider: "edge",
      catalogMax: 4000,
    });
    expect(catalogMax).toBeUndefined();
    expect(
      maxCharsForModel({
        provider: "fish",
        model: "s2.1-pro-free",
        catalogMax,
      })
    ).toBe(FISH_TARGET_CHARS);
    expect(
      catalogMaxForStoredProvider({
        storedProvider: "edge",
        catalogProvider: "edge",
        catalogMax: 4000,
      })
    ).toBe(4000);
  });

  it("falls back to the provider then to a safe default", () => {
    expect(maxCharsForModel({ provider: "grok" })).toBe(8000);
    expect(maxCharsForModel({ provider: "fish" })).toBe(8000);
    expect(maxCharsForModel({ provider: "gemini" })).toBe(2800);
    expect(maxCharsForModel({ provider: "openrouter", model: "some/unknown" })).toBe(
      2000
    );
    expect(maxCharsForModel({})).toBe(2000);
    expect(maxCharsForModel({ provider: "google" })).toBe(4500);
  });
});

describe("streamWindowChars", () => {
  it("keeps live listen windows short for fast first sound", () => {
    expect(streamWindowChars(8000)).toBe(STREAM_WINDOW_CHARS);
  });

  it("never exceeds the model's own limit", () => {
    expect(streamWindowChars(350)).toBe(350);
  });
});

describe("evenTakehomeTargetChars", () => {
  it("even-packs a mid-size book across one Fish fan-out wave", () => {
    // ~34k + fanout 5 → five ~6.8k slices, not 2k + four 8k.
    expect(evenTakehomeTargetChars(34_000, 5)).toBe(6_800);
  });

  it("uses fewest waves that still fit under the Fish hard max", () => {
    // 5 workers × 9200 = 46k per wave → 50k needs two waves.
    expect(evenTakehomeTargetChars(50_000, 5)).toBe(5_000);
  });

  it("floors tiny books at FISH_EVEN_PACK_MIN_CHARS", () => {
    expect(FISH_EVEN_PACK_MIN_CHARS).toBe(1_500);
    expect(evenTakehomeTargetChars(500, 5)).toBe(FISH_EVEN_PACK_MIN_CHARS);
    expect(evenTakehomeTargetChars(0, 5)).toBe(FISH_EVEN_PACK_MIN_CHARS);
  });

  it("caps the even target at FISH_TARGET_CHARS so overflow room remains", () => {
    expect(evenTakehomeTargetChars(40_000, 5)).toBe(FISH_TARGET_CHARS);
    expect(evenTakehomeTargetChars(34_000, 4)).toBe(FISH_TARGET_CHARS);
    expect(evenTakehomeTargetChars(100_000, 5)).toBeLessThanOrEqual(
      FISH_TARGET_CHARS
    );
    expect(evenTakehomeTargetChars(100_000, 5)).toBeLessThanOrEqual(
      FISH_HARD_MAX_CHARS
    );
  });

  it("treats a missing fan-out as one worker", () => {
    expect(evenTakehomeTargetChars(34_000, 0)).toBe(FISH_TARGET_CHARS);
    expect(evenTakehomeTargetChars(1_200, Number.NaN)).toBe(
      FISH_EVEN_PACK_MIN_CHARS
    );
  });
});

describe("edgeGoogleTakehomeTargetChars", () => {
  it("aims for eight sections, floored at 1500 and capped at the voice max", () => {
    expect(EDGE_GOOGLE_PACK_MIN_CHARS).toBe(1_500);
    expect(edgeGoogleTakehomeTargetChars(18_500, 4000)).toBe(2313);
    expect(edgeGoogleTakehomeTargetChars(5_000, 4000)).toBe(1_500);
    expect(edgeGoogleTakehomeTargetChars(80_000, 4000)).toBe(4000);
    expect(edgeGoogleTakehomeTargetChars(80_000, 4500)).toBe(4500);
  });
});

describe("hardMaxCharsForModel", () => {
  it("caps Google Whole-book under Cloud TTS's 5000-byte SSML limit", () => {
    expect(
      hardMaxCharsForModel({ provider: "google", catalogMax: 4500 })
    ).toBe(GOOGLE_SSML_HARD_MAX_BYTES);
    expect(GOOGLE_SSML_HARD_MAX_BYTES).toBeLessThanOrEqual(5000);
  });

  it("does not grant overflow past a catalog or engine ceiling", () => {
    expect(hardMaxCharsForModel({ provider: "edge", catalogMax: 4500 })).toBe(4500);
    expect(hardMaxCharsForModel({ model: "zyphra/zonos-v0.1", target: 1000 })).toBe(350);
    expect(hardMaxCharsForModel({ provider: "openai", target: 800 })).toBe(800);
  });
});

describe("Kokoro CPU section sizing", () => {
  it("targets ~700 characters by default with a short opening", () => {
    expect(KOKORO_CPU_SECTION_CHARS_DEFAULT).toBe(700);
    expect(kokoroCpuSectionChars({} as NodeJS.ProcessEnv)).toBe(700);
    const plan = kokoroCpuSectionPlan({} as NodeJS.ProcessEnv);
    expect(plan.maxChars).toBe(700);
    // First audio lands within about 15–20 s of speech, not a full section.
    expect(plan.firstSectionMaxChars).toBe(KOKORO_CPU_FIRST_SECTION_CHARS);
    expect(plan.firstSectionMaxChars).toBeLessThan(plan.maxChars);
    // The second section steps up to the steady target.
    expect(plan.secondSectionMaxChars).toBeLessThanOrEqual(plan.maxChars);
    expect(plan.thirdSectionMaxChars).toBe(plan.maxChars);
    // Overflow slack, but never past the container's per-request cap.
    expect(plan.hardMaxChars).toBeGreaterThan(plan.maxChars);
    expect(plan.hardMaxChars).toBeLessThanOrEqual(KOKORO_CPU_REQUEST_MAX_CHARS);
    // Same slack the packer itself uses (target + max(200, 25%)), so the
    // local copy cannot drift from `hardMaxForTarget`.
    expect(plan.hardMaxChars).toBe(Math.min(2000, 700 + Math.max(200, Math.round(700 * 0.25))));
  });

  it("honours KOKORO_CPU_SECTION_CHARS and clamps it to 300..2000", () => {
    expect(
      kokoroCpuSectionChars({ KOKORO_CPU_SECTION_CHARS: "900" } as NodeJS.ProcessEnv)
    ).toBe(900);
    expect(
      kokoroCpuSectionChars({ KOKORO_CPU_SECTION_CHARS: "100" } as NodeJS.ProcessEnv)
    ).toBe(KOKORO_CPU_SECTION_CHARS_MIN);
    expect(
      kokoroCpuSectionChars({ KOKORO_CPU_SECTION_CHARS: "9999" } as NodeJS.ProcessEnv)
    ).toBe(KOKORO_CPU_SECTION_CHARS_MAX);
    expect(
      kokoroCpuSectionChars({ KOKORO_CPU_SECTION_CHARS: "abc" } as NodeJS.ProcessEnv)
    ).toBe(KOKORO_CPU_SECTION_CHARS_DEFAULT);
    expect(
      kokoroCpuSectionChars({ KOKORO_CPU_SECTION_CHARS: "  " } as NodeJS.ProcessEnv)
    ).toBe(KOKORO_CPU_SECTION_CHARS_DEFAULT);
    // A 2,000-char override leaves no overflow room; the hard max is the cap.
    const plan = kokoroCpuSectionPlan({
      KOKORO_CPU_SECTION_CHARS: "2000",
    } as NodeJS.ProcessEnv);
    expect(plan.maxChars).toBe(2000);
    expect(plan.hardMaxChars).toBe(2000);
  });

  it("keeps the opening shorter than the target for every legal override", () => {
    for (const value of ["300", "450", "700", "1200", "2000"]) {
      const plan = kokoroCpuSectionPlan({
        KOKORO_CPU_SECTION_CHARS: value,
      } as NodeJS.ProcessEnv);
      expect(plan.firstSectionMaxChars).toBeLessThanOrEqual(plan.maxChars);
      expect(plan.secondSectionMaxChars).toBeLessThanOrEqual(plan.maxChars);
      expect(plan.hardMaxChars).toBeGreaterThanOrEqual(plan.maxChars);
      expect(plan.hardMaxChars).toBeLessThanOrEqual(KOKORO_CPU_REQUEST_MAX_CHARS);
    }
  });

  it("identifies only the Kokoro CPU providers", () => {
    expect(isKokoroCpuProvider("drew")).toBe(true);
    expect(isKokoroCpuProvider("sowell")).toBe(true);
    expect(isKokoroCpuProvider("george")).toBe(true);
    expect(isKokoroCpuProvider("heart")).toBe(true);
    expect(isKokoroCpuProvider("DREW")).toBe(true);
    // Every other engine keeps its own packing.
    for (const other of ["edge", "google", "fish", "paradee", "gemini", "grok", "openrouter", ""]) {
      expect(isKokoroCpuProvider(other)).toBe(false);
    }
    expect(isKokoroCpuProvider(null)).toBe(false);
    expect(isKokoroCpuProvider(undefined)).toBe(false);
  });

  it("leaves every other engine's request ceiling untouched", () => {
    expect(maxCharsForModel({ provider: "edge" })).toBe(2000);
    expect(maxCharsForModel({ provider: "fish" })).toBe(FISH_TARGET_CHARS);
    expect(maxCharsForModel({ provider: "paradee" })).toBe(2000);
    expect(hardMaxCharsForModel({ provider: "fish" })).toBe(FISH_HARD_MAX_CHARS);
    // The Kokoro ceiling is still the request cap, independent of the target.
    expect(maxCharsForModel({ provider: "drew" })).toBe(2000);
    expect(hardMaxCharsForModel({ provider: "drew" })).toBe(2000);
    expect(hardMaxCharsForModel({ provider: "sowell" })).toBe(2000);
    expect(hardMaxCharsForModel({ provider: "george" })).toBe(2000);
  });
});
