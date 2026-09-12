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

  it("routes Michelle to Edge and Clara to Fish even when OpenRouter is configured", () => {
    const previousOr = process.env.OPENROUTER_API_KEY;
    const previousFish = process.env.FISH_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.FISH_API_KEY = "test-fish";
    try {
      expect(
        resolveStockAdapter({
          provider: "edge",
          model: "edge/en-US-MichelleNeural",
          catalogVoiceId: "michelle",
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

  it("routes Randolph to Google Cloud TTS even when OpenRouter is configured", () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      expect(
        resolveStockAdapter({
          provider: "google",
          model: "google/en-GB-Neural2-O",
          catalogVoiceId: "randolph",
        }).id
      ).toBe("google");
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
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
