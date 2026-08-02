/**
 * Internal research preview — MiniMax Free API (OpenAI-compatible reverse proxy).
 *
 * Off by default. Never customer-facing. Requires:
 *   RESEARCH_PREVIEW_ENABLED=true
 *   RESEARCH_PREVIEW_ALLOWLIST=<session userId and/or IP>
 *   MINIMAX_FREE_API_BASE_URL=http://host:8000
 *   MINIMAX_FREE_API_TOKEN=<realUserID>+<_token>
 *
 * Take-home through this path is denied unless RESEARCH_PREVIEW_ALLOW_TAKEHOME=true
 * (full books hammer reverse APIs and risk account bans).
 */

import type { CatalogVoice } from "@/lib/tts/types";
import { MINIMAX_SEEDED_VOICES } from "@/lib/tts/catalog/allowlist";
import { enrichCatalogVoice } from "@/lib/tts/voice-persona";

export const RESEARCH_PROVIDER = "research" as const;
export const RESEARCH_MODEL = "research/minimax-free";
export const RESEARCH_TAG = "research-preview";
export const RESEARCH_ID_PREFIX = "research:minimax-free:";

export function isResearchPreviewConfigured(): boolean {
  return (
    process.env.RESEARCH_PREVIEW_ENABLED === "true" &&
    Boolean(process.env.MINIMAX_FREE_API_BASE_URL?.trim()) &&
    Boolean(process.env.MINIMAX_FREE_API_TOKEN?.trim())
  );
}

export function isResearchPreviewAllowTakehome(): boolean {
  return process.env.RESEARCH_PREVIEW_ALLOW_TAKEHOME === "true";
}

function allowlistEntries(): string[] {
  return (process.env.RESEARCH_PREVIEW_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Caller is on the internal allowlist (user id and/or IP). */
export function isResearchPreviewAllowed(opts?: {
  ip?: string | null;
  userId?: string | null;
}): boolean {
  if (!isResearchPreviewConfigured()) return false;
  const allow = allowlistEntries();
  if (allow.length === 0) return false;
  const candidates = [opts?.ip, opts?.userId].filter(Boolean) as string[];
  return candidates.some((c) => allow.includes(c));
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

/** Catalog cards visible only when the research preview gate is open. */
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
      displayName: `${seed.displayName} (Research)`,
      language: "English",
      locale: seed.locale,
      gender: seed.gender,
      style: seed.style,
      tags: [RESEARCH_TAG, "minimax", "hd", "internal"],
      latencyClass: "quality",
      model: RESEARCH_MODEL,
      recommendedForLongForm: false,
      supportsNativeStream: true,
      maxCharsPerRequest: 2000,
      qualityNotes:
        "Internal research preview via MiniMax Free API reverse proxy. Not for production customers. Unstable; may ban accounts.",
      accentHint: nativeAccent,
      // No retail price — research path is not sold
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

export function researchPreviewDeniedMessage(): string {
  return "That narrator is an internal research preview and isn't available on this account.";
}

export function researchTakehomeDeniedMessage(): string {
  return "Research-preview narrators can't generate full audiobooks unless RESEARCH_PREVIEW_ALLOW_TAKEHOME is enabled.";
}
