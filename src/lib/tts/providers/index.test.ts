import { describe, expect, it } from "vitest";
import { resolveStockAdapter } from "./index";

describe("resolveStockAdapter", () => {
  it("routes Standard to Edge even when OpenRouter is configured", () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      expect(
        resolveStockAdapter({
          provider: "edge",
          model: "edge/en-US-AndrewNeural",
          catalogVoiceId: "standard",
        }).id
      ).toBe("edge");
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("routes Ava to Edge and Clara to Fish even when OpenRouter is configured", () => {
    const previousOr = process.env.OPENROUTER_API_KEY;
    const previousFish = process.env.FISH_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.FISH_API_KEY = "test-fish";
    try {
      expect(
        resolveStockAdapter({
          provider: "edge",
          model: "edge/en-US-AvaNeural",
          catalogVoiceId: "ava",
        }).id
      ).toBe("edge");
      expect(
        resolveStockAdapter({
          provider: "fish",
          model: "s2.1-pro-free",
          catalogVoiceId: "clara",
        }).id
      ).toBe("fish");
    } finally {
      if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOr;
      if (previousFish === undefined) delete process.env.FISH_API_KEY;
      else process.env.FISH_API_KEY = previousFish;
    }
  });

  it("routes Echomancer Andrew to Paradee and keeps Standard on Edge", () => {
    const previousOr = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      expect(
        resolveStockAdapter({
          provider: "paradee",
          model: "paradee/paradee-v1.1-int8",
          catalogVoiceId: "echomancer-andrew",
        }).id
      ).toBe("paradee");
      expect(
        resolveStockAdapter({
          provider: "edge",
          model: "edge/en-US-AndrewNeural",
          catalogVoiceId: "standard",
        }).id
      ).toBe("edge");
    } finally {
      if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOr;
    }
  });

  it("does not treat Echomancer Andrew as the Edge Standard voice", async () => {
    const { isStandardVoice, isEdgeStockVoice, coercePlainCatalogVoiceId } =
      await import("@/lib/tts/standard-voice");
    for (const hint of [
      { id: "echomancer-andrew" },
      { id: "echomancer-andrew", provider: "paradee" },
      {
        id: "echomancer-andrew",
        provider: "paradee",
        model: "paradee/paradee-v1.1-int8",
      },
      { provider: "paradee", model: "paradee/paradee-v1.1-int8" },
    ]) {
      expect(isStandardVoice(hint)).toBe(false);
      expect(isEdgeStockVoice(hint)).toBe(false);
    }
    expect(coercePlainCatalogVoiceId("echomancer-andrew")).toBe(
      "echomancer-andrew"
    );
  });

  it("refuses a stored Google voice instead of speaking it", () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      expect(() =>
        resolveStockAdapter({
          provider: "google",
          model: "google/en-GB-Neural2-O",
          catalogVoiceId: "randolph",
        })
      ).toThrow(/Google Cloud TTS has been removed/i);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("routes a stored Fish provider to Fish", () => {
    expect(
      resolveStockAdapter({
        provider: "fish",
        model: "s2.1-pro-free",
        catalogVoiceId: "standard",
      }).id
    ).toBe("fish");
    expect(
      resolveStockAdapter({
        provider: "fish",
        model: "s2.1-pro-free",
        catalogVoiceId: "randolph",
      }).id
    ).toBe("fish");
  });

  it("keeps Fish clones on the Fish adapter", () => {
    const previous = process.env.FISH_API_KEY;
    process.env.FISH_API_KEY = "test-fish";
    try {
      expect(
        resolveStockAdapter({
          provider: "fish",
          catalogVoiceId: "clone:abc",
        }).id
      ).toBe("fish");
    } finally {
      if (previous === undefined) delete process.env.FISH_API_KEY;
      else process.env.FISH_API_KEY = previous;
    }
  });
});
