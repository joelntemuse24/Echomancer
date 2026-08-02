import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogVoice } from "@/lib/tts/types";

const mocks = vi.hoisted(() => ({
  fetchOpenRouterCatalogVoices: vi.fn(),
  isResearchPreviewConfigured: vi.fn(() => false),
  listResearchPreviewVoices: vi.fn(() => [] as CatalogVoice[]),
  getResearchPreviewVoice: vi.fn(() => undefined as CatalogVoice | undefined),
}));

vi.mock("./openrouter-catalog", () => ({
  fetchOpenRouterCatalogVoices: mocks.fetchOpenRouterCatalogVoices,
}));

vi.mock("@/lib/tts/research-preview", () => ({
  isResearchPreviewConfigured: () => mocks.isResearchPreviewConfigured(),
  listResearchPreviewVoices: () => mocks.listResearchPreviewVoices(),
  getResearchPreviewVoice: (id: string) => mocks.getResearchPreviewVoice(id),
}));

import {
  getCatalogVoice,
  getDefaultCatalogVoice,
  listCatalogVoices,
} from "./index";

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

const researchStoryteller: CatalogVoice = {
  id: "research:minimax-free:English_CaptivatingStoryteller",
  provider: "research",
  providerVoiceId: "English_CaptivatingStoryteller",
  displayName: "Storyteller",
  language: "English",
  locale: "en-US",
  gender: "male",
  style: "narrative",
  tags: ["research-preview", "minimax", "hd", "default"],
  latencyClass: "quality",
  model: "research/minimax-free",
  recommendedForLongForm: true,
  supportsNativeStream: true,
  maxCharsPerRequest: 2000,
};

describe("TTS catalog HD filtering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isResearchPreviewConfigured.mockReturnValue(false);
    mocks.listResearchPreviewVoices.mockReturnValue([]);
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

describe("slim Free API test catalog", () => {
  const ENV_KEYS = [
    "MINIMAX_FREE_API_BASE_URL",
    "MINIMAX_FREE_API_TOKEN",
  ] as const;
  const snapshot: Partial<
    Record<(typeof ENV_KEYS)[number], string | undefined>
  > = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) snapshot[key] = process.env[key];
    vi.resetAllMocks();
    mocks.isResearchPreviewConfigured.mockReturnValue(true);
    mocks.listResearchPreviewVoices.mockReturnValue([researchStoryteller]);
    mocks.getResearchPreviewVoice.mockImplementation((id: string) =>
      id === researchStoryteller.id ? researchStoryteller : undefined
    );
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  it("lists only Storyteller Free API + Gemini Kore", async () => {
    const voices = await listCatalogVoices();
    expect(voices.map((v) => v.id)).toEqual([
      "research:minimax-free:English_CaptivatingStoryteller",
      "gemini-kore",
    ]);
    expect(mocks.fetchOpenRouterCatalogVoices).not.toHaveBeenCalled();
  });

  it("defaults to Storyteller when Free API is configured", () => {
    const def = getDefaultCatalogVoice();
    expect(def.id).toBe(researchStoryteller.id);
  });
});
