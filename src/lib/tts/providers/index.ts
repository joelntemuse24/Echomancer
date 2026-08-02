import type { StockProvider, TtsProviderAdapter } from "@/lib/tts/types";
import { googleTtsProvider } from "./google";
import { grokTtsProvider } from "./grok";
import { geminiTtsProvider } from "./gemini";
import {
  openrouterTtsProvider,
  getOpenRouterApiKey,
} from "./openrouter";
import { minimaxFreeTtsProvider } from "./minimax-free";
import { isResearchVoice } from "@/lib/tts/research-preview";

const providers: Record<StockProvider, TtsProviderAdapter> = {
  google: googleTtsProvider,
  grok: grokTtsProvider,
  gemini: geminiTtsProvider,
  openrouter: openrouterTtsProvider,
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
  const p = providers[id];
  if (!p) throw new Error(`Unknown TTS provider: ${id}`);
  return p;
}

/**
 * Prefer OpenRouter for any stock job when key is present.
 * Research-preview voices always route to the MiniMax Free API adapter.
 * Direct provider APIs remain a fallback when OpenRouter is not configured.
 */
export function resolveStockAdapter(opts: {
  provider: string;
  model?: string | null;
}): TtsProviderAdapter {
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
  throw new Error(`Unknown TTS provider: ${opts.provider} and OpenRouter not configured`);
}

export function isStockProvider(id: string): id is StockProvider {
  return (
    id === "google" ||
    id === "grok" ||
    id === "gemini" ||
    id === "openrouter" ||
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
  getOpenRouterApiKey,
};
