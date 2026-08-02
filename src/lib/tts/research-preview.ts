/**
 * MiniMax Free API TTS path (OpenAI-compatible reverse proxy).
 *
 * Enabled when both are set:
 *   MINIMAX_FREE_API_BASE_URL=http://host:8000
 *   MINIMAX_FREE_API_TOKEN=<realUserID>+<_token>
 *
 * While those are set, the app catalog is slimmed to this one preset voice
 * plus a single Gemini fallback (see catalog/index.ts). Unset to hide MiniMax.
 */

import type { CatalogVoice } from "@/lib/tts/types";
import { enrichCatalogVoice } from "@/lib/tts/voice-persona";

export const RESEARCH_PROVIDER = "research" as const;
export const RESEARCH_MODEL = "research/minimax-free";
export const RESEARCH_TAG = "research-preview";
export const RESEARCH_ID_PREFIX = "research:minimax-free:";

/** Single preset we use for Free API testing. */
export const DEFAULT_MINIMAX_FREE_VOICE = {
  id: "English_CaptivatingStoryteller",
  displayName: "Storyteller",
  gender: "male" as const,
  locale: "en-US",
  style: "narrative",
};

export function isResearchPreviewConfigured(): boolean {
  return (
    Boolean(process.env.MINIMAX_FREE_API_BASE_URL?.trim()) &&
    Boolean(process.env.MINIMAX_FREE_API_TOKEN?.trim())
  );
}

/** @deprecated Use isResearchPreviewConfigured */
export function isResearchPreviewAllowed(_opts?: {
  ip?: string | null;
  userId?: string | null;
}): boolean {
  return isResearchPreviewConfigured();
}

export function getMinimaxFreeApiBaseUrl(): string {
  return (process.env.MINIMAX_FREE_API_BASE_URL || "").replace(/\/+$/, "");
}

export function getMinimaxFreeApiToken(): string {
  return process.env.MINIMAX_FREE_API_TOKEN?.trim() || "";
}

export function isResearchVoice(voice: {
  id?: string | null;
  provider?: string | null;
  model?: string | null;
  tags?: string[] | null;
}): boolean {
  if (voice.provider === RESEARCH_PROVIDER) return true;
  if (voice.model === RESEARCH_MODEL) return true;
  if (voice.id?.startsWith(RESEARCH_ID_PREFIX)) return true;
  return Boolean(voice.tags?.some((t) => t.toLowerCase() === RESEARCH_TAG));
}

export function defaultResearchVoiceId(): string {
  return `${RESEARCH_ID_PREFIX}${DEFAULT_MINIMAX_FREE_VOICE.id}`;
}

/** One preset MiniMax card when Free API env vars are set; otherwise empty. */
export function listResearchPreviewVoices(): CatalogVoice[] {
  if (!isResearchPreviewConfigured()) return [];

  const seed = DEFAULT_MINIMAX_FREE_VOICE;
  const base: CatalogVoice = {
    id: `${RESEARCH_ID_PREFIX}${seed.id}`,
    provider: RESEARCH_PROVIDER,
    providerVoiceId: seed.id,
    displayName: seed.displayName,
    language: "English",
    locale: seed.locale,
    gender: seed.gender,
    style: seed.style,
    tags: [RESEARCH_TAG, "minimax", "hd", "default"],
    latencyClass: "quality",
    model: RESEARCH_MODEL,
    recommendedForLongForm: true,
    supportsNativeStream: true,
    maxCharsPerRequest: 2000,
    qualityNotes:
      "Default test narrator via MiniMax Free API. Set MINIMAX_FREE_API_* env vars.",
    accentHint: "american",
    usdPerMillionChars: undefined,
  };
  return [enrichCatalogVoice(base)];
}

export function getResearchPreviewVoice(
  id: string
): CatalogVoice | undefined {
  if (!id.startsWith(RESEARCH_ID_PREFIX)) return undefined;
  return listResearchPreviewVoices().find((v) => v.id === id);
}
