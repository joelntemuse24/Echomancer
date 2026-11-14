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
    // Drew is the default and lives on our own CPU app, so the listed catalog
    // (and the default) only include it while its endpoint is configured.
    process.env.DREW_ENABLED = "1";
    process.env.DREW_URL = "https://example.modal.run";
    process.env.DREW_TOKEN = "token";
    delete process.env.SOWELL_ENABLED;
    delete process.env.SOWELL_URL;
    delete process.env.SOWELL_TOKEN;
    delete process.env.GEORGE_ENABLED;
    delete process.env.GEORGE_URL;
    delete process.env.GEORGE_TOKEN;
  });

  afterEach(() => {
    delete process.env.DREW_ENABLED;
    delete process.env.DREW_URL;
    delete process.env.DREW_TOKEN;
  });

  it("lists Drew, Ava, and Libby, and keeps Andrew and Ryan off the list", async () => {
    const voices = await listCatalogVoices();
    expect(voices.map((v) => v.id)).toEqual([
      DEFAULT_VOICE_ID,
      "echomancer-andrew",
      "ava",
      "libby",
    ]);
    expect(voices.map((v) => v.displayName)).toEqual([
      "Drew",
      "Echomancer Andrew",
      "Ava",
      "Libby",
    ]);
    expect(voices.map((v) => v.id)).not.toContain("michelle");
    expect(voices.map((v) => v.id)).not.toContain("clara");
    expect(voices.map((v) => v.id)).not.toContain("standard");
    expect(voices[0]!.provider).toBe("drew");
    expect(voices[0]!.providerVoiceId).toBe("drew");
    expect(voices[1]!.provider).toBe("paradee");
    expect(voices[1]!.model).toBe("paradee/paradee-v1.1-int8");
    expect(voices[2]!.providerVoiceId).toBe("en-US-AvaNeural");
    expect(voices[3]!.providerVoiceId).toBe("en-GB-LibbyNeural");
    expect(voices[3]!.provider).toBe("edge");
    expect(voices.map((v) => v.id)).not.toContain("ryan");
    expect(voices.map((v) => v.id)).not.toContain("george");
    expect(voices.map((v) => v.id)).not.toContain("standard");
    // Drew replaces the retired Edge male; the Paradee student stays listed
    // under its own self-hosted name.
    expect(voices.map((v) => v.displayName)).toContain("Drew");
    expect(voices.map((v) => v.displayName)).not.toContain("Andrew");
    for (const voice of voices) {
      expect(voice.displayName).not.toMatch(
        /fish|microsoft|neural2|en-GB-|en-US-|google|klett|librivox/i
      );
    }
    expect(mocks.fetchOpenRouterCatalogVoices).not.toHaveBeenCalled();
  });

  it("does not ship rejected Edge females (Jenny, Sonia, …)", async () => {
    const voices = await listCatalogVoices();
    const labels = voices.map((v) => `${v.id} ${v.displayName} ${v.friendlyName}`);
    const blob = labels.join("\n");
    for (const name of REJECTED_EDGE_FEMALE_LABELS) {
      expect(blob).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    }
    expect(voices.map((v) => v.id)).not.toEqual(
      expect.arrayContaining(["jenny", "sonia", "emma", "aria", "michelle", "clara"])
    );
    for (const name of UNSHIPPED_STOCK_LABELS) {
      expect(blob).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
    }
  });

  it("defaults to Drew, the fine-tuned Kokoro narrator", () => {
    const def = getDefaultCatalogVoice();
    expect(def.id).toBe(DEFAULT_VOICE_ID);
    expect(def.provider).toBe("drew");
    expect(def.providerVoiceId).toBe("drew");
    expect(def.usdPerMillionChars).toBe(0);
  });

  it("lists Walter under its new name and never lists the retired Andrew row", async () => {
    process.env.SOWELL_ENABLED = "1";
    process.env.SOWELL_URL = "https://example.modal.run";
    process.env.SOWELL_TOKEN = "token";
    try {
      const voices = await listCatalogVoices();
      const walter = voices.find((v) => v.id === "sowell");
      expect(walter?.displayName).toBe("Walter");
      expect(walter?.friendlyName).toBe("Walter");
      // `echomancer-andrew` is a different, still-listed voice (Paradee). The
      // retired Edge `standard` row is the one that must be gone.
      expect(voices.map((v) => v.id)).not.toContain("standard");
      expect(voices.map((v) => v.id)).not.toContain("ryan");
      expect(voices.map((v) => v.displayName)).not.toContain("Sowell");
      expect(voices.map((v) => v.displayName)).not.toContain("Andrew");
    } finally {
      delete process.env.SOWELL_ENABLED;
      delete process.env.SOWELL_URL;
      delete process.env.SOWELL_TOKEN;
    }
  });

  it("falls back to Ava when Drew's endpoint is not configured", () => {
    delete process.env.DREW_ENABLED;
    const def = getDefaultCatalogVoice();
    expect(def.id).toBe("ava");
    expect(def.provider).toBe("edge");
  });

  it("resolves the default voice by id", async () => {
    const found = await getCatalogVoice(DEFAULT_VOICE_ID);
    expect(found?.id).toBe(DEFAULT_VOICE_ID);
  });

  it("still resolves the retired Andrew row for a stored book", async () => {
    await expect(getCatalogVoice("standard")).resolves.toMatchObject({
      id: "standard",
      provider: "edge",
      providerVoiceId: "en-US-AndrewNeural",
    });
  });

  it("resolves Ava and Clara by id and drops Randolph", async () => {
    await expect(getCatalogVoice("ava")).resolves.toMatchObject({
      id: "ava",
      displayName: "Ava",
      provider: "edge",
      providerVoiceId: "en-US-AvaNeural",
    });
    await expect(getCatalogVoice("michelle")).resolves.toMatchObject({
      id: "michelle",
      displayName: "Michelle",
      provider: "edge",
    });
    await expect(getCatalogVoice("libby")).resolves.toMatchObject({
      id: "libby",
      displayName: "Libby",
      provider: "edge",
      providerVoiceId: "en-GB-LibbyNeural",
    });
    await expect(getCatalogVoice("clara")).resolves.toMatchObject({
      id: "clara",
      displayName: "Clara",
      provider: "fish",
    });
    await expect(getCatalogVoice("randolph")).resolves.toBeUndefined();
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
      "echomancer-andrew",
      "ava",
      "libby",
    ]);
    expect(getDefaultCatalogVoice().id).toBe(DEFAULT_VOICE_ID);
  });
});
