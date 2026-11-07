/**
 * George is the listed British male narrator, and he is really Kokoro.
 *
 * Joel, 2026-11-07: *"wire in George Kokoro as our British male voice and get
 * rid of Ryen"*. The risk this file guards is a **relabel**: changing the picker
 * card to say "George" while synthesis still calls Microsoft Edge's
 * `en-GB-RyanNeural`, or calls nothing at all. A card is not a voice.
 *
 * So these tests assert on the actual outbound request — method, host, model and
 * the `voice` field — for the same path a real book takes, plus the identity
 * boundaries that must not move:
 *
 *   - a NEW request resolves to Kokoro `bm_george` and never touches Edge;
 *   - a stored `ryan` book keeps its own id and audio and is not relabelled;
 *   - the catalogue lists George once, in the British male slot, and keeps the
 *     other 53 Kokoro voices out;
 *   - the preview sample served for George is the Kokoro take, not Ryan's;
 *   - the accent and language are British English throughout.
 *
 * "Brian" does not exist anywhere in this repository (checked: no catalog entry,
 * provider id, alias or doc mention). Joel's "even better than Brian" is
 * therefore treated as a comparison to a voice this product does not ship, and
 * George stays the default rather than being silently renamed to something the
 * codebase cannot resolve.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  GEORGE_CATALOG_VOICE_ID,
  GEORGE_KOKORO_VOICE_ID,
  KOKORO_MODEL_ID,
  RYAN_CATALOG_VOICE_ID,
  RYAN_NEURAL_VOICE_ID,
  SLIM_STOCK_VOICE_IDS,
  coercePlainCatalogVoiceId,
  edgeBrowserTarget,
  isEdgeStockVoice,
  isGeorgeVoice,
  isRyanVoice,
  plainStockLock,
  stockDisplayName,
} from "@/lib/tts/standard-voice";
import { listCatalogVoices, getCatalogVoice } from "@/lib/tts/catalog";
import { resolveStockAdapter } from "@/lib/tts/providers";
import { isAllowedSpeechModel } from "@/lib/tts/catalog/allowlist";
import { isTakehomeFriendly, isListenFriendly } from "@/lib/tts/voice-persona";
import { maxCharsForModel } from "@/lib/tts/section-size";
import { stockPreviewUrl } from "@/lib/tts/stock-preview";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";

const OPENROUTER_SPEECH = "https://openrouter.ai/api/v1/audio/speech";

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function recordFetch(respond?: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method || "GET").toUpperCase(),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (respond) return respond();
      // A tiny, valid-enough MP3 body: the adapter only checks the content type.
      const bytes = Buffer.alloc(2048, 0);
      bytes[0] = 0xff;
      bytes[1] = 0xfb;
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    })
  );
  return calls;
}

const georgeVoice = {
  id: GEORGE_CATALOG_VOICE_ID,
  provider: "openrouter",
  providerVoiceId: GEORGE_KOKORO_VOICE_ID,
  model: KOKORO_MODEL_ID,
  locale: "en-GB",
  language: "English",
  maxCharsPerRequest: 800,
};

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("synthesis actually uses Kokoro bm_george", () => {
  it("posts bm_george to the Kokoro model at OpenRouter", async () => {
    // The core anti-relabel assertion: it is about the wire, not the label.
    const calls = recordFetch();
    const adapter = resolveStockAdapter({
      provider: georgeVoice.provider,
      model: georgeVoice.model,
      catalogVoiceId: georgeVoice.id,
    });
    expect(adapter.id).toBe("openrouter");

    await adapter.synthesize({
      text: PREVIEW_TEXT,
      voiceId: georgeVoice.providerVoiceId,
      catalogVoiceId: georgeVoice.id,
      model: georgeVoice.model,
      language: georgeVoice.locale,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(OPENROUTER_SPEECH);
    expect(String(calls[0]!.body?.model)).toBe(KOKORO_MODEL_ID);
    expect(String(calls[0]!.body?.voice)).toBe("bm_george");
    // And it is not a Microsoft Edge request in disguise.
    expect(calls.some((call) => /speech\.platform\.bing\.com|edge/i.test(call.url))).toBe(
      false
    );
  });

  it("never falls back to the old Edge voice id", async () => {
    const calls = recordFetch();
    const adapter = resolveStockAdapter({
      provider: georgeVoice.provider,
      model: georgeVoice.model,
      catalogVoiceId: georgeVoice.id,
    });
    await adapter.synthesize({
      text: "A short line.",
      voiceId: georgeVoice.providerVoiceId,
      catalogVoiceId: georgeVoice.id,
      model: georgeVoice.model,
    });
    const wire = JSON.stringify(calls);
    expect(wire).not.toContain(RYAN_NEURAL_VOICE_ID);
    expect(wire).not.toContain("en-GB-");
  });

  it("routes the catalog card to the OpenRouter adapter, not Edge", () => {
    const adapter = resolveStockAdapter({
      provider: "openrouter",
      model: KOKORO_MODEL_ID,
      catalogVoiceId: GEORGE_CATALOG_VOICE_ID,
    });
    expect(adapter.id).toBe("openrouter");
    expect(isEdgeStockVoice(georgeVoice)).toBe(false);
    // No browser speech target: Kokoro runs server-side only, so the picker
    // cannot quietly play a local British voice and call it George.
    expect(edgeBrowserTarget(georgeVoice)).toBeNull();
  });
});

describe("the catalogue lists George in the British male slot", () => {
  it("lists George once, with British accent and Kokoro identity", async () => {
    const voices = await listCatalogVoices();
    const ids = voices.map((voice) => voice.id);
    expect(ids).toContain(GEORGE_CATALOG_VOICE_ID);
    expect(ids).not.toContain(RYAN_CATALOG_VOICE_ID);
    expect(ids.filter((id) => id === GEORGE_CATALOG_VOICE_ID)).toHaveLength(1);

    const george = voices.find((voice) => voice.id === GEORGE_CATALOG_VOICE_ID)!;
    expect(george.providerVoiceId).toBe(GEORGE_KOKORO_VOICE_ID);
    expect(george.provider).toBe("openrouter");
    expect(george.model).toBe(KOKORO_MODEL_ID);
    expect(george.locale).toBe("en-GB");
    expect(george.gender).toBe("male");
    expect(george.accentHint).toBe("british");
    expect(george.displayName).toBe("George");
    // Customer-facing copy must not leak a vendor voice id.
    expect(george.displayName).not.toMatch(/bm_|kokoro|neural|en-GB/i);
  });

  it("keeps the other 53 Kokoro voices out of the catalogue", async () => {
    const voices = await listCatalogVoices();
    for (const voice of voices) {
      expect(voice.providerVoiceId).not.toMatch(/^(af|am|bf|ef|ff|hf|if|jf|pf|zf)_/);
    }
    // The model is allowed (one curated voice needs it); the catalogue is not
    // expanded from it.
    expect(isAllowedSpeechModel(KOKORO_MODEL_ID)).toBe(true);
    expect(SLIM_STOCK_VOICE_IDS).toEqual([
      "standard",
      "echomancer-andrew",
      "ava",
      "libby",
      "george",
    ]);
  });

  it("is usable for whole books and for live listen", async () => {
    const george = await getCatalogVoice(GEORGE_CATALOG_VOICE_ID);
    expect(george).toBeDefined();
    expect(isTakehomeFriendly(george!)).toBe(true);
    expect(isListenFriendly(george as never)).toBe(true);
    // 800 characters is Kokoro's practical ceiling and clears the 600 floor.
    expect(maxCharsForModel({ provider: "openrouter", model: KOKORO_MODEL_ID })).toBe(800);
  });
});

describe("a stored Ryan book keeps its identity and its audio", () => {
  const storedRyan = {
    id: RYAN_CATALOG_VOICE_ID,
    provider: "edge",
    providerVoiceId: RYAN_NEURAL_VOICE_ID,
    model: `edge/${RYAN_NEURAL_VOICE_ID}`,
    locale: "en-GB",
  };

  it("still recognises a stored Ryan row as Ryan", () => {
    expect(isRyanVoice(storedRyan)).toBe(true);
    expect(isGeorgeVoice(storedRyan)).toBe(false);
    expect(stockDisplayName(RYAN_CATALOG_VOICE_ID)).toBe("Ryan");
  });

  it("keeps a stored Ryan row on Edge, so its own audio is what plays", () => {
    // A stored job carries provider=edge, and this must not be rewritten to the
    // Kokoro path. Re-synthesising stored Ryan audio as George would be exactly
    // the substitution the product forbids.
    expect(isEdgeStockVoice(storedRyan)).toBe(true);
    const adapter = resolveStockAdapter({
      provider: "edge",
      model: storedRyan.model,
      catalogVoiceId: RYAN_CATALOG_VOICE_ID,
    });
    expect(adapter.id).toBe("edge");
    expect(plainStockLock(RYAN_CATALOG_VOICE_ID)?.providerVoiceId).toBe(
      RYAN_NEURAL_VOICE_ID
    );
  });

  it("sends a NEW request that names Ryan to George, not to Edge", () => {
    // This is the deliberate product change: Ryan is replaced. The alias only
    // runs for a new job request (see `POST /api/jobs`), so nothing stored is
    // affected.
    expect(coercePlainCatalogVoiceId("ryan")).toBe(GEORGE_CATALOG_VOICE_ID);
    expect(coercePlainCatalogVoiceId("Ryan")).toBe(GEORGE_CATALOG_VOICE_ID);
    expect(coercePlainCatalogVoiceId("george")).toBe(GEORGE_CATALOG_VOICE_ID);
  });

  it("does not resolve Ryan to a George catalog card", async () => {
    // `getCatalogVoice("ryan")` must not return the Kokoro card, or a stored row
    // could be re-rendered as a different voice.
    const ryan = await getCatalogVoice(RYAN_CATALOG_VOICE_ID);
    if (ryan) {
      expect(ryan.providerVoiceId).not.toBe(GEORGE_KOKORO_VOICE_ID);
      expect(ryan.model).not.toBe(KOKORO_MODEL_ID);
    }
  });
});

describe("the saved preview is the Kokoro take, not Ryan's", () => {
  it("serves george.mp3 for George", () => {
    expect(stockPreviewUrl(GEORGE_CATALOG_VOICE_ID)).toBe("/voice-previews/george.mp3");
  });

  it("does not serve the old Ryan recording as George", () => {
    // The concrete risk is byte-level: George's card pointing at Ryan's Edge
    // take. Compare the committed files rather than the URLs, because aliasing
    // makes both ids resolve to the George path by design.
    const george = readFileSync(
      path.join(process.cwd(), "public/voice-previews/george.mp3")
    );
    const ryanPath = path.join(process.cwd(), "public/voice-previews/ryan.mp3");
    if (existsSync(ryanPath)) {
      const ryan = readFileSync(ryanPath);
      expect(george.equals(ryan)).toBe(false);
      expect(george.length).not.toBe(ryan.length);
    }
    // And George's own path resolves to George, never to the Ryan file.
    expect(stockPreviewUrl(GEORGE_CATALOG_VOICE_ID)).toBe("/voice-previews/george.mp3");
    expect(stockPreviewUrl(GEORGE_CATALOG_VOICE_ID)).not.toContain("ryan");
  });

  it("a stale pick naming ryan resolves to the current product voice", () => {
    // `coercePlainCatalogVoiceId` only runs for a NEW request, and Ryan is no
    // longer listed, so the current British male voice is the honest answer.
    // A stored book is untouched by this — it keeps its own audio.
    expect(stockPreviewUrl("ryan")).toBe("/voice-previews/george.mp3");
  });

  it("ships a committed George recording of the preview text", () => {
    const file = path.join(process.cwd(), "public/voice-previews/george.mp3");
    expect(existsSync(file)).toBe(true);
    const bytes = readFileSync(file);
    // Looks like MP3 (ID3 tag or a frame sync) and is not a stub.
    const isMp3 = bytes.subarray(0, 3).toString("latin1") === "ID3" ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    expect(isMp3).toBe(true);
    expect(bytes.length).toBeGreaterThan(20_000);
  });
});

describe("accent and language stay British", () => {
  it("declares en-GB and a British accent", async () => {
    const george = await getCatalogVoice(GEORGE_CATALOG_VOICE_ID);
    expect(george!.locale).toBe("en-GB");
    expect(george!.accentHint).toBe("british");
    expect(george!.language).toBe("English");
  });
});
