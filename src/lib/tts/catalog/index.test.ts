import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogVoice } from "@/lib/tts/types";

const mocks = vi.hoisted(() => ({
  fetchOpenRouterCatalogVoices: vi.fn(),
}));

vi.mock("./openrouter-catalog", () => ({
  fetchOpenRouterCatalogVoices: mocks.fetchOpenRouterCatalogVoices,
}));

import { getCatalogVoice, listCatalogVoices } from "./index";

const standardVoice: CatalogVoice = {
  id: "or:standard",
  provider: "openrouter",
  providerVoiceId: "Kore",
  displayName: "Kore",
  language: "English",
  locale: "en-US",
  gender: "female",
  style: "narration",
  tags: [],
  latencyClass: "fast",
  model: "google/gemini-3.1-flash-tts-preview",
  recommendedForLongForm: true,
  supportsNativeStream: true,
  maxCharsPerRequest: 3000,
};

const hdVoice: CatalogVoice = {
  ...standardVoice,
  id: "or:hd",
  providerVoiceId: "English_CaptivatingStoryteller",
  displayName: "Storyteller",
  tags: ["hd"],
  model: "minimax/speech-2.8-hd",
  latencyClass: "quality",
};

const blockedVoice: CatalogVoice = {
  ...standardVoice,
  id: "or:blocked",
  providerVoiceId: "af_bella",
  displayName: "Bella",
  model: "hexgrad/kokoro-82m",
};

describe("TTS catalog HD filtering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchOpenRouterCatalogVoices.mockResolvedValue([
      standardVoice,
      hdVoice,
      blockedVoice,
    ]);
  });

  it("hides HD voices by default and includes them only when enabled", async () => {
    const withoutHd = await listCatalogVoices();
    expect(withoutHd.map((v) => v.id)).toEqual(["or:standard"]);

    const withHd = await listCatalogVoices({ hdEnabled: true });
    expect(withHd.map((v) => v.id)).toEqual(["or:standard", "or:hd"]);
  });

  it("drops non-allowlisted vendors even if OpenRouter returns them", async () => {
    const voices = await listCatalogVoices({ hdEnabled: true });
    expect(voices.map((v) => v.id)).not.toContain("or:blocked");
  });

  it("applies the same default to individual lookups", async () => {
    await expect(getCatalogVoice(hdVoice.id)).resolves.toBeUndefined();
    const found = await getCatalogVoice(hdVoice.id, { hdEnabled: true });
    expect(found?.id).toBe(hdVoice.id);
  });
});
