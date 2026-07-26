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
  providerVoiceId: "alloy",
  displayName: "Standard",
  language: "English",
  locale: "en-US",
  gender: "neutral",
  style: "narration",
  tags: [],
  latencyClass: "balanced",
  model: "openai/gpt-4o-mini-tts",
  recommendedForLongForm: true,
  supportsNativeStream: true,
  maxCharsPerRequest: 4000,
};

const hdVoice: CatalogVoice = {
  ...standardVoice,
  id: "or:hd",
  providerVoiceId: "hd-narrator",
  displayName: "HD",
  tags: ["hd"],
  model: "minimax/speech-02-hd",
};

describe("TTS catalog HD filtering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchOpenRouterCatalogVoices.mockResolvedValue([
      standardVoice,
      hdVoice,
    ]);
  });

  it("hides HD voices by default and includes them only when enabled", async () => {
    await expect(listCatalogVoices()).resolves.toEqual([standardVoice]);
    await expect(
      listCatalogVoices({ hdEnabled: true })
    ).resolves.toEqual([standardVoice, hdVoice]);
  });

  it("applies the same default to individual lookups", async () => {
    await expect(getCatalogVoice(hdVoice.id)).resolves.toBeUndefined();
    await expect(
      getCatalogVoice(hdVoice.id, { hdEnabled: true })
    ).resolves.toEqual(hdVoice);
  });
});
