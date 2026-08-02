import { beforeEach, describe, expect, it, vi } from "vitest";
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
  DEFAULT_VOICE_ID,
  getCatalogVoice,
  getDefaultCatalogVoice,
  listCatalogVoices,
} from "./index";

const hdVoice: CatalogVoice = {
  id: "or:hd",
  provider: "openrouter",
  providerVoiceId: "English_CaptivatingStoryteller",
  displayName: "Storyteller",
  language: "English",
  locale: "en-US",
  gender: "male",
  style: "narrative",
  tags: ["hd"],
  latencyClass: "quality",
  model: "minimax/speech-2.8-hd",
  recommendedForLongForm: true,
  supportsNativeStream: true,
  maxCharsPerRequest: 2800,
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

describe("slim default catalog (Fish S2.1 Pro Free)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isResearchPreviewConfigured.mockReturnValue(false);
    mocks.listResearchPreviewVoices.mockReturnValue([]);
  });

  it("lists only Fish Narrator + Gemini Kore by default", async () => {
    const voices = await listCatalogVoices();
    expect(voices.map((v) => v.id)).toEqual([DEFAULT_VOICE_ID, "gemini-kore"]);
    expect(voices[0]!.model).toBe("fish-audio/s2.1-pro-free:free");
    expect(mocks.fetchOpenRouterCatalogVoices).not.toHaveBeenCalled();
  });

  it("defaults to Fish Audio S2.1 Pro Free", () => {
    const def = getDefaultCatalogVoice();
    expect(def.id).toBe(DEFAULT_VOICE_ID);
    expect(def.model).toBe("fish-audio/s2.1-pro-free:free");
    expect(def.usdPerMillionChars).toBe(0);
  });

  it("resolves the default voice by id", async () => {
    const found = await getCatalogVoice(DEFAULT_VOICE_ID);
    expect(found?.id).toBe(DEFAULT_VOICE_ID);
  });

  it("still looks up legacy OpenRouter ids for in-flight jobs", async () => {
    mocks.fetchOpenRouterCatalogVoices.mockResolvedValue([hdVoice]);
    await expect(getCatalogVoice(hdVoice.id)).resolves.toBeUndefined();
    const found = await getCatalogVoice(hdVoice.id, { hdEnabled: true });
    expect(found?.id).toBe(hdVoice.id);
  });
});

describe("slim Free API override catalog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isResearchPreviewConfigured.mockReturnValue(true);
    mocks.listResearchPreviewVoices.mockReturnValue([researchStoryteller]);
    mocks.getResearchPreviewVoice.mockImplementation((id: string) =>
      id === researchStoryteller.id ? researchStoryteller : undefined
    );
  });

  it("lists Storyteller Free API + Gemini Kore when Free API env is set", async () => {
    const voices = await listCatalogVoices();
    expect(voices.map((v) => v.id)).toEqual([
      "research:minimax-free:English_CaptivatingStoryteller",
      "gemini-kore",
    ]);
  });

  it("defaults to Storyteller when Free API is configured", () => {
    const def = getDefaultCatalogVoice();
    expect(def.id).toBe(researchStoryteller.id);
  });
});
