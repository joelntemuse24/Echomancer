import type { StockProvider, TtsProviderAdapter } from "@/lib/tts/types";
import { googleTtsProvider, isGoogleTtsConfigured } from "./google";
import { grokTtsProvider } from "./grok";
import { geminiTtsProvider } from "./gemini";
import {
  openrouterTtsProvider,
  getOpenRouterApiKey,
} from "./openrouter";
import { minimaxFreeTtsProvider } from "./minimax-free";
import {
  fishTtsProvider,
  getFishApiKey,
  isFishConfigured,
  isFishLiveVoice,
} from "./fish";
import { isResearchVoice } from "@/lib/tts/research-preview";
import { isFishCloneVoice } from "@/lib/tts/fish-clone";
import { edgeTtsProvider } from "./edge";
import { isEdgeStockVoice, isRandolphVoice } from "@/lib/tts/standard-voice";

const providers: Record<StockProvider, TtsProviderAdapter> = {
  google: googleTtsProvider,
  grok: grokTtsProvider,
  gemini: geminiTtsProvider,
  openrouter: openrouterTtsProvider,
  fish: fishTtsProvider,
  edge: edgeTtsProvider,
  research: minimaxFreeTtsProvider,
};

/**
 * Resolve adapter. When OpenRouter key is set, prefer it for openrouter
 * and optionally route google/gemini through OpenRouter if model slug is set.
 */
export function getTtsProvider(id: StockProvider): TtsProviderAdapter {
  if (id === "openrouter") {
    return openrouterTtsProvider;
  }
  if (id === "research") {
    return minimaxFreeTtsProvider;
  }
  if (id === "fish") {
    return fishTtsProvider;
  }
  if (id === "edge") {
    return edgeTtsProvider;
  }
  const p = providers[id];
  if (!p) throw new Error(`Unknown TTS provider: ${id}`);
  return p;
}

/**
 * Prefer Edge for Standard / Michelle, unless the stored provider is already
 * `fish` (a quality-gated Fish twin). Randolph uses Google Cloud TTS
 * (must win before the OpenRouter catch-all) on the same rule. Fish clones
 * always use the direct Fish adapter (private reference ids). When
 * FISH_API_KEY is set, leftover Fish catalog voices also use the direct
 * adapter. OpenRouter is the fallback for other stock ids. Research-preview
 * voices always route to the MiniMax Free API adapter. In-flight Edge /
 * Google jobs keep those adapters even after a twin gate opens.
 */
export function resolveStockAdapter(opts: {
  provider: string;
  model?: string | null;
  catalogVoiceId?: string | null;
}): TtsProviderAdapter {
  const hint = {
    id: opts.catalogVoiceId,
    provider: opts.provider,
    model: opts.model,
  };
  if (isEdgeStockVoice(hint)) {
    return edgeTtsProvider;
  }
  if (isRandolphVoice(hint) || opts.provider === "google") {
    return googleTtsProvider;
  }
  if (
    opts.provider === "fish" ||
    isFishCloneVoice({
      provider: opts.provider,
      id: opts.catalogVoiceId,
    }) ||
    isFishLiveVoice({
      provider: opts.provider,
      model: opts.model,
      catalogVoiceId: opts.catalogVoiceId,
    })
  ) {
    return fishTtsProvider;
  }
  if (
    isResearchVoice({
      provider: opts.provider,
      model: opts.model,
    })
  ) {
    return minimaxFreeTtsProvider;
  }
  if (getOpenRouterApiKey()) {
    return openrouterTtsProvider;
  }
  if (isStockProvider(opts.provider)) {
    return getTtsProvider(opts.provider);
  }
  throw new Error(
    `Unknown TTS provider: ${opts.provider} and OpenRouter not configured`
  );
}

export function isStockProvider(id: string): id is StockProvider {
  return (
    id === "google" ||
    id === "grok" ||
    id === "gemini" ||
    id === "openrouter" ||
    id === "fish" ||
    id === "edge" ||
    id === "research"
  );
}

export function isOpenRouterConfigured(): boolean {
  return Boolean(getOpenRouterApiKey());
}

export {
  googleTtsProvider,
  grokTtsProvider,
  geminiTtsProvider,
  openrouterTtsProvider,
  minimaxFreeTtsProvider,
  fishTtsProvider,
  edgeTtsProvider,
  getOpenRouterApiKey,
  getFishApiKey,
  isFishConfigured,
  isFishLiveVoice,
  isGoogleTtsConfigured,
};
