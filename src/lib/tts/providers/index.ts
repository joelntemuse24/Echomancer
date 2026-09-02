import type { StockProvider, TtsProviderAdapter } from "@/lib/tts/types";
import { googleTtsProvider } from "./google";
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

const providers: Record<StockProvider, TtsProviderAdapter> = {
  google: googleTtsProvider,
  grok: grokTtsProvider,
  gemini: geminiTtsProvider,
  openrouter: openrouterTtsProvider,
  fish: fishTtsProvider,
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
  const p = providers[id];
  if (!p) throw new Error(`Unknown TTS provider: ${id}`);
  return p;
}

/**
 * Prefer OpenRouter for stock jobs when key is present.
 * Fish clones always use the direct Fish adapter (private reference ids).
 * When FISH_API_KEY is set, Fish Audio catalog voices also use the direct
 * adapter so HTTP chunked streaming (low TTFA) works for listen + preview.
 * Stock Narrator still uses that Fish path, but without posting the OpenRouter
 * catalog UUID as `reference_id` (Fish default S2.1 Pro Free voice).
 * Research-preview voices always route to the MiniMax Free API adapter.
 */
export function resolveStockAdapter(opts: {
  provider: string;
  model?: string | null;
  catalogVoiceId?: string | null;
}): TtsProviderAdapter {
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
  getOpenRouterApiKey,
  getFishApiKey,
  isFishConfigured,
  isFishLiveVoice,
};
