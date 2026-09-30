import type { StockProvider, TtsProviderAdapter } from "@/lib/tts/types";
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
import {
  isEdgeStockVoice,
  isRetiredGoogleSynthesis,
} from "@/lib/tts/standard-voice";

const providers: Record<Exclude<StockProvider, "google">, TtsProviderAdapter> = {
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
  if (id === "google") {
    throw new Error(
      "Google Cloud TTS has been removed. Audio already saved for this book is unchanged."
    );
  }
  const p = providers[id];
  if (!p) throw new Error(`Unknown TTS provider: ${id}`);
  return p;
}

export class RetiredGoogleVoiceError extends Error {
  constructor() {
    super(
      "Google Cloud TTS has been removed. Audio already saved for this book is unchanged."
    );
    this.name = "RetiredGoogleVoiceError";
  }
}

/**
 * Prefer Edge for Andrew / Ava / Libby / Ryan (and legacy Michelle). A stored
 * Google / Randolph row is not spoken again. A stored `fish` provider stays
 * on Fish. Fish clones always use the direct Fish adapter (private reference
 * ids). When FISH_API_KEY is set, leftover Fish catalog voices also use the
 * direct adapter. OpenRouter is the fallback for other stock ids.
 * Research-preview voices always route to the MiniMax Free API adapter.
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
  const model = (opts.model || "").toLowerCase();
  if (
    opts.provider !== "fish" &&
    (isRetiredGoogleSynthesis({
      provider: opts.provider,
      providerVoiceId: opts.model,
    }) ||
      model.includes("en-gb-neural2-o") ||
      model.includes("en-gb-neural2-b"))
  ) {
    throw new RetiredGoogleVoiceError();
  }
  if (isEdgeStockVoice(hint)) {
    return edgeTtsProvider;
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
};
