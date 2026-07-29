/**
 * Stock TTS types — all voices via OpenRouter.
 * Premium = high-quality HD models (e.g. Minimax) gated by subscription.
 */

export type StockProvider = "google" | "grok" | "gemini" | "openrouter";
export type TtsProvider = StockProvider;

export type GenerationMode = "stock";
export type JobKind = "stream" | "takehome";

export type LatencyClass = "fast" | "balanced" | "quality";
export type Gender = "female" | "male" | "neutral";
export type CatalogAccent =
  | "american"
  | "british"
  | "australian"
  | "irish"
  | "other";

export interface CatalogVoice {
  id: string;
  provider: StockProvider;
  /** Provider-native voice id (e.g. en-US-Neural2-J, Eve, Kore) */
  providerVoiceId: string;
  displayName: string;
  language: string;
  locale: string;
  gender: Gender;
  style: string;
  tags: string[];
  latencyClass: LatencyClass;
  /** Model/tier used for pricing + synthesis */
  model: string;
  recommendedForLongForm: boolean;
  supportsNativeStream: boolean;
  maxCharsPerRequest: number;
  qualityNotes?: string;
  /** Steering prompt (accent / delivery) for Gemini-style engines */
  stylePrompt?: string;
  /**
   * Explicit accent from catalog expansion (trusted over inference).
   * Prevents locale leftovers / tag bleed from mislabeling cards.
   */
  accentHint?: CatalogAccent;
  /** Approx USD per million characters (character-billed engines) */
  usdPerMillionChars?: number;
  /** Approx USD per audio hour (token-billed engines like Gemini TTS) */
  usdPerAudioHour?: number;
}

export interface SynthesizeInput {
  text: string;
  voiceId: string;
  language?: string;
  model?: string;
  speed?: number;
  /** Optional style / system prompt for Gemini-style engines */
  stylePrompt?: string;
  /** Optional abort signal for stream cancellation */
  signal?: AbortSignal;
}

export interface SynthesizeResult {
  audio: Buffer;
  contentType: string;
  durationHintSeconds?: number;
}

export interface TtsProviderAdapter {
  id: StockProvider;
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
  synthesizeStream(input: SynthesizeInput): AsyncIterable<Uint8Array>;
  /** Expected content type for stream output (defaults to audio/mpeg) */
  streamContentType?: string | ((model?: string) => string);
}

export interface JobSegment {
  index: number;
  path: string;
  status: "ready" | "failed";
  contentType?: string;
  durationSeconds?: number;
  error?: string;
}

export interface PriceEstimate {
  charCount: number;
  estimatedAudioHours: number;
  estimatedAudioMinutes: number;
  ttsCogsUsd: number;
  suggestedPriceEur: number;
  currency: "EUR";
  provider: string;
  model: string;
  targetPriceEur: number;
  breakdown: {
    charsPerHour: number;
    markup: number;
    fixedEur: number;
    fxUsdToEur: number;
  };
}
