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
import {
  REJECTED_EDGE_FEMALE_LABELS,
  UNSHIPPED_STOCK_LABELS,
} from "@/lib/tts/standard-voice";

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

describe("Standard slim catalog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isResearchPreviewConfigured.mockReturnValue(false);
    mocks.listResearchPreviewVoices.mockReturnValue([]);
  });

  it("lists Andrew, Michelle, Clara, Randolph (no rejected Edge females)", async () => {
    const voices = await listCatalogVoices();
    expect(voices.map((v) => v.id)).toEqual([
      DEFAULT_VOICE_ID,
      "michelle",
      "clara",
      "randolph",
    ]);
    expect(voices.map((v) => v.displayName)).toEqual([
      "Andrew",
      "Michelle",
      "Clara",
      "Randolph",
    ]);
    expect(voices[0]!.providerVoiceId).toBe("en-US-AndrewNeural");
    expect(voices[1]!.providerVoiceId).toBe("en-US-MichelleNeural");
    expect(voices[2]!.providerVoiceId).toBe("a50f1ee074124ba2b1dc44623f99abbe");
    expect(voices[2]!.provider).toBe("fish");
    expect(voices[3]!.providerVoiceId).toBe("en-GB-Neural2-O");
    expect(voices[3]!.provider).toBe("google");
    for (const voice of voices) {
      expect(voice.displayName).not.toMatch(
        /fish|microsoft|neural2|en-GB|en-US|google|klett|librivox|ava|libby/i
      );
    }
    expect(mocks.fetchOpenRouterCatalogVoices).not.toHaveBeenCalled();
  });

  it("does not ship rejected Edge females (Ava, Libby, Jenny, Sonia, …)", async () => {
    const voices = await listCatalogVoices();
    const labels = voices.map((v) => `${v.id} ${v.displayName} ${v.friendlyName}`);
    const blob = labels.join("\n");
    for (const name of REJECTED_EDGE_FEMALE_LABELS) {
      expect(blob).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    }
    expect(voices.map((v) => v.id)).not.toEqual(
      expect.arrayContaining(["ava", "libby", "jenny", "sonia", "emma", "aria"])
    );
    for (const name of UNSHIPPED_STOCK_LABELS) {
      expect(blob).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    }
  });

  it("defaults to Standard → en-US-AndrewNeural", () => {
    const def = getDefaultCatalogVoice();
    expect(def.id).toBe(DEFAULT_VOICE_ID);
    expect(def.provider).toBe("edge");
    expect(def.providerVoiceId).toBe("en-US-AndrewNeural");
    expect(def.usdPerMillionChars).toBe(0);
  });

  it("resolves the default voice by id", async () => {
    const found = await getCatalogVoice(DEFAULT_VOICE_ID);
    expect(found?.id).toBe(DEFAULT_VOICE_ID);
  });

  it("resolves Michelle, Clara, and Randolph by id", async () => {
    await expect(getCatalogVoice("michelle")).resolves.toMatchObject({
      id: "michelle",
      displayName: "Michelle",
      provider: "edge",
    });
    await expect(getCatalogVoice("clara")).resolves.toMatchObject({
      id: "clara",
      displayName: "Clara",
      provider: "fish",
    });
    await expect(getCatalogVoice("randolph")).resolves.toMatchObject({
      id: "randolph",
      displayName: "Randolph",
      provider: "google",
    });
  });

  it("still resolves legacy fish-narrator for in-flight jobs", async () => {
    const found = await getCatalogVoice("fish-narrator");
    expect(found?.id).toBe("fish-narrator");
    expect(found?.model).toContain("fish-audio");
  });

  it("still looks up legacy OpenRouter ids for in-flight jobs", async () => {
    mocks.fetchOpenRouterCatalogVoices.mockResolvedValue([hdVoice]);
    await expect(getCatalogVoice(hdVoice.id)).resolves.toBeUndefined();
    const found = await getCatalogVoice(hdVoice.id, { hdEnabled: true });
    expect(found?.id).toBe(hdVoice.id);
  });

  it("ignores MiniMax Free API env for the listed catalog", async () => {
    mocks.isResearchPreviewConfigured.mockReturnValue(true);
    mocks.listResearchPreviewVoices.mockReturnValue([researchStoryteller]);
    const voices = await listCatalogVoices();
    expect(voices.map((v) => v.id)).toEqual([
      DEFAULT_VOICE_ID,
      "michelle",
      "clara",
      "randolph",
    ]);
    expect(getDefaultCatalogVoice().id).toBe(DEFAULT_VOICE_ID);
  });
});
