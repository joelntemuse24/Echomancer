/**
 * MiniMax Free API TTS path (OpenAI-compatible reverse proxy).
 *
 * Enabled when both are set:
 *   MINIMAX_FREE_API_BASE_URL=http://host:8000
 *   MINIMAX_FREE_API_TOKEN=<realUserID>+<_token>
 *
 * Then research voices appear in the catalog like every other narrator
 * (preview, stream, take-home). Leave the env vars unset to hide them.
 */

import type { CatalogVoice } from "@/lib/tts/types";
import { MINIMAX_SEEDED_VOICES } from "@/lib/tts/catalog/allowlist";
import { enrichCatalogVoice } from "@/lib/tts/voice-persona";

export const RESEARCH_PROVIDER = "research" as const;
export const RESEARCH_MODEL = "research/minimax-free";
export const RESEARCH_TAG = "research-preview";
export const RESEARCH_ID_PREFIX = "research:minimax-free:";

/** True when the Free API proxy is configured. */
export function isResearchPreviewConfigured(): boolean {
  return (
    Boolean(process.env.MINIMAX_FREE_API_BASE_URL?.trim()) &&
    Boolean(process.env.MINIMAX_FREE_API_TOKEN?.trim())
  );
}

/** @deprecated Use isResearchPreviewConfigured — no per-user allowlist anymore. */
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

/** Catalog cards when the Free API env vars are set; otherwise empty. */
export function listResearchPreviewVoices(): CatalogVoice[] {
  if (!isResearchPreviewConfigured()) return [];

  return MINIMAX_SEEDED_VOICES.map((seed) => {
    const nativeAccent = seed.locale.startsWith("en-GB")
      ? ("british" as const)
      : seed.locale.startsWith("en-AU")
        ? ("australian" as const)
        : seed.locale.startsWith("en-IE")
          ? ("irish" as const)
          : ("american" as const);

    const base: CatalogVoice = {
      id: `${RESEARCH_ID_PREFIX}${seed.id}`,
      provider: RESEARCH_PROVIDER,
      providerVoiceId: seed.id,
      displayName: seed.displayName,
      language: "English",
      locale: seed.locale,
      gender: seed.gender,
      style: seed.style,
      tags: [RESEARCH_TAG, "minimax", "hd"],
      latencyClass: "quality",
      model: RESEARCH_MODEL,
      recommendedForLongForm: true,
      supportsNativeStream: true,
      maxCharsPerRequest: 2000,
      qualityNotes:
        "MiniMax via Free API proxy (research). Set MINIMAX_FREE_API_* env vars.",
      accentHint: nativeAccent,
      usdPerMillionChars: undefined,
    };
    return enrichCatalogVoice(base);
  });
}

export function getResearchPreviewVoice(
  id: string
): CatalogVoice | undefined {
  if (!id.startsWith(RESEARCH_ID_PREFIX)) return undefined;
  return listResearchPreviewVoices().find((v) => v.id === id);
}
