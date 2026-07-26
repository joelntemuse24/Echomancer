import type { StockProvider, TtsProviderAdapter } from "@/lib/tts/types";
import { googleTtsProvider } from "./google";
import { grokTtsProvider } from "./grok";
import { geminiTtsProvider } from "./gemini";
import {
  openrouterTtsProvider,
  getOpenRouterApiKey,
} from "./openrouter";

const providers: Record<StockProvider, TtsProviderAdapter> = {
  google: googleTtsProvider,
  grok: grokTtsProvider,
  gemini: geminiTtsProvider,
  openrouter: openrouterTtsProvider,
};

/**
 * Resolve adapter. When OpenRouter key is set, prefer it for openrouter
 * and optionally route google/gemini through OpenRouter if model slug is set.
 */
export function getTtsProvider(id: StockProvider): TtsProviderAdapter {
  if (id === "openrouter") {
    return openrouterTtsProvider;
  }
  // If only OpenRouter is configured, still allow openrouter id
  const p = providers[id];
  if (!p) throw new Error(`Unknown TTS provider: ${id}`);
  return p;
}

/**
 * Prefer OpenRouter for any stock job when key is present.
 * OpenRouter is the unified gateway for all voices — only use direct
 * provider APIs as a fallback when OpenRouter is not configured.
 */
export function resolveStockAdapter(opts: {
  provider: string;
  model?: string | null;
}): TtsProviderAdapter {
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
    id === "openrouter"
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
  getOpenRouterApiKey,
};
