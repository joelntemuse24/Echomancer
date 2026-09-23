import { afterEach, describe, expect, it, vi } from "vitest";
import { getCatalogVoice, listCatalogVoices } from "@/lib/tts/catalog";
import { isFishCloneVoice } from "@/lib/tts/fish-clone";
import {
  narrationScriptForSynthesis,
  usesNarrationPauseScript,
} from "@/lib/tts/narration-script";
import { resolveStockAdapter } from "@/lib/tts/providers";
import { FishStockTwinReferenceError } from "@/lib/tts/fish-stock-twins";
import { isUserCloneVoice } from "@/lib/voice-path";
import {
  FISH_TWIN_GATE_ENV,
  FISH_TWIN_QUALITY_PASSAGE,
  FISH_TWIN_REF_ENV,
  activeFishStockTwin,
  fishStockTwinReport,
  normalizeFishModelReferenceId,
} from "./fish-stock-twins";

const SAMPLE_REF = "a50f1ee074124ba2b1dc44623f99abbe";

function clearTwinEnv() {
  for (const key of Object.values(FISH_TWIN_GATE_ENV)) delete process.env[key];
  for (const key of Object.values(FISH_TWIN_REF_ENV)) delete process.env[key];
}

describe("fish stock twins", () => {
  afterEach(() => {
    clearTwinEnv();
  });

  it("holds Standard, Michelle, and Randolph on their baseline providers", () => {
    const report = fishStockTwinReport();
    expect(report.map((row) => row.catalogId)).toEqual([
      "standard",
      "michelle",
      "randolph",
    ]);
    for (const row of report) {
      expect(row.recommendation).toBe("hold");
      expect(row.routing).toBe("baseline");
      expect(row.gateOpen).toBe(false);
      expect(row.referenceId).toBeNull();
      expect(row.holdReason.length).toBeGreaterThan(20);
      expect(row.candidateSource).toMatch(/librivox\.org/i);
    }
    expect(report[0]!.baselineProvider).toBe("edge");
    expect(report[0]!.baselineVoiceId).toBe("en-US-AndrewNeural");
    expect(report[1]!.baselineProvider).toBe("edge");
    expect(report[2]!.baselineProvider).toBe("google");
    expect(report[2]!.baselineVoiceId).toBe("en-GB-Neural2-O");
    expect(activeFishStockTwin("standard")).toBeNull();
  });

  it("rejects neural ids and dashed OpenRouter UUIDs as Fish references", () => {
    expect(normalizeFishModelReferenceId("en-US-AndrewNeural")).toBeNull();
    expect(normalizeFishModelReferenceId("en-GB-Neural2-O")).toBeNull();
    expect(
      normalizeFishModelReferenceId("00a1b221-6137-4b73-ad62-b0cbce134167")
    ).toBeNull();
    expect(normalizeFishModelReferenceId(`  ${SAMPLE_REF.toUpperCase()} `)).toBe(
      SAMPLE_REF
    );
  });

  it("stays on Edge when the gate is open but no reference is wired", async () => {
    process.env.FISH_TWIN_STANDARD = "1";
    expect(activeFishStockTwin("standard")).toBeNull();
    const voice = await getCatalogVoice("standard");
    expect(voice?.provider).toBe("edge");
    expect(voice?.providerVoiceId).toBe("en-US-AndrewNeural");
  });

  it("stays on the baseline when a reference is set but the quality gate is closed", async () => {
    process.env.FISH_TWIN_MICHELLE_REF = SAMPLE_REF;
    expect(activeFishStockTwin("michelle")).toBeNull();
    const voice = await getCatalogVoice("michelle");
    expect(voice?.provider).toBe("edge");
    expect(voice?.providerVoiceId).toBe("en-US-MichelleNeural");
  });

  it("ignores a non-Fish reference even if the gate is open", () => {
    process.env.FISH_TWIN_RANDOLPH = "1";
    process.env.FISH_TWIN_RANDOLPH_REF = "en-GB-Neural2-O";
    expect(activeFishStockTwin("randolph")).toBeNull();
  });

  it("publishes a Fish card with cue-markup routing only when reference and gate are both set", async () => {
    process.env.FISH_TWIN_STANDARD = "yes";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;

    const voice = await getCatalogVoice("standard");
    expect(voice).toMatchObject({
      id: "standard",
      displayName: "Standard",
      provider: "fish",
      providerVoiceId: SAMPLE_REF,
      model: "s2.1-pro-free",
      maxCharsPerRequest: 8000,
    });
    expect(voice?.displayName).not.toMatch(/andrew|edge|fish/i);
    expect(voice?.tags).toContain("fish-audio");
    expect(usesNarrationPauseScript(voice!.provider)).toBe(true);

    const fishScript = narrationScriptForSynthesis(
      FISH_TWIN_QUALITY_PASSAGE,
      voice!.provider
    );
    const edgeScript = narrationScriptForSynthesis(
      FISH_TWIN_QUALITY_PASSAGE,
      "edge"
    );
    expect(fishScript).toContain("[soft tone]");
    expect(fishScript).toContain("[emphasis]");
    expect(fishScript).toContain("[long-break]");
    expect(edgeScript).not.toContain("[soft tone]");
    expect(edgeScript).not.toContain("[emphasis]");

    expect(
      resolveStockAdapter({
        provider: voice!.provider,
        model: voice!.model,
        catalogVoiceId: "standard",
      }).id
    ).toBe("fish");

    const listed = await listCatalogVoices();
    expect(listed.find((row) => row.id === "standard")?.provider).toBe("fish");
    expect(listed.find((row) => row.id === "michelle")?.provider).toBe("edge");
    expect(listed.find((row) => row.id === "randolph")?.provider).toBe("google");
  });

  it("keeps an in-flight Edge job on Edge after the Standard gate opens", () => {
    process.env.FISH_TWIN_STANDARD = "1";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;
    expect(
      resolveStockAdapter({
        provider: "edge",
        model: "edge/en-US-AndrewNeural",
        catalogVoiceId: "standard",
      }).id
    ).toBe("edge");
  });

  it("routes a stored Fish Randolph job to Fish ahead of Google", () => {
    expect(
      resolveStockAdapter({
        provider: "fish",
        model: "s2.1-pro-free",
        catalogVoiceId: "randolph",
      }).id
    ).toBe("fish");
  });

  it("does not treat twin slots as user clones", () => {
    expect(
      isUserCloneVoice({
        id: "standard",
        provider: "fish",
        providerVoiceId: SAMPLE_REF,
        tags: ["fish-audio", "fish-twin"],
      })
    ).toBe(false);
    expect(
      isFishCloneVoice({
        id: "michelle",
        provider: "fish",
        providerVoiceId: SAMPLE_REF,
      })
    ).toBe(false);
    expect(isFishCloneVoice({ provider: "fish" })).toBe(true);
  });

  it("refuses to call Fish for a twin slot without a real reference id", async () => {
    const previous = process.env.FISH_API_KEY;
    process.env.FISH_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { fishTtsProvider } = await import("./providers/fish");
      await expect(
        fishTtsProvider.synthesize({
          text: "Hello",
          voiceId: "en-US-AndrewNeural",
          catalogVoiceId: "standard",
          model: "s2.1-pro-free",
        })
      ).rejects.toBeInstanceOf(FishStockTwinReferenceError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.FISH_API_KEY;
      else process.env.FISH_API_KEY = previous;
    }
  });

  it("sends the wired reference id for a live twin", async () => {
    const previous = process.env.FISH_API_KEY;
    process.env.FISH_API_KEY = "test-key";
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { fishTtsProvider } = await import("./providers/fish");
      await fishTtsProvider.synthesize({
        text: "Hello",
        voiceId: SAMPLE_REF,
        catalogVoiceId: "michelle",
        model: "s2.1-pro-free",
      });
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
        reference_id: SAMPLE_REF,
      });
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.FISH_API_KEY;
      else process.env.FISH_API_KEY = previous;
    }
  });
});
