/**
 * User-scoped Fish Audio cloned voices → catalog cards.
 */

import type { CatalogVoice } from "@/lib/tts/types";
import { enrichCatalogVoice } from "@/lib/tts/voice-persona";
import {
  FISH_NATIVE_FREE_MODEL,
  isFishConfigured,
} from "@/lib/tts/providers/fish";

export const CLONE_ID_PREFIX = "clone:";

export type ClonedVoiceRow = {
  id: string;
  user_id: string;
  fish_voice_id: string;
  title: string;
  sample_storage_path: string | null;
  state: string;
  model: string;
  created_at: number;
  deleted_at: number | null;
};

export function isFishCloneCatalogId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(CLONE_ID_PREFIX));
}

export function catalogIdForClone(cloneRowId: string): string {
  return `${CLONE_ID_PREFIX}${cloneRowId}`;
}

export function cloneRowIdFromCatalogId(catalogId: string): string | null {
  if (!catalogId.startsWith(CLONE_ID_PREFIX)) return null;
  return catalogId.slice(CLONE_ID_PREFIX.length) || null;
}

export function isFishCloneVoice(voice: {
  id?: string | null;
  provider?: string | null;
  tags?: string[] | null;
}): boolean {
  if (voice.provider === "fish") return true;
  if (voice.id && isFishCloneCatalogId(voice.id)) return true;
  return Boolean(voice.tags?.some((t) => t.toLowerCase() === "cloned"));
}

export function clonedVoiceToCatalog(row: ClonedVoiceRow): CatalogVoice {
  const base: CatalogVoice = {
    id: catalogIdForClone(row.id),
    provider: "fish",
    providerVoiceId: row.fish_voice_id,
    displayName: row.title,
    language: "English",
    locale: "en-US",
    gender: "neutral",
    style: "cloned",
    tags: ["cloned", "fish-audio", "custom"],
    latencyClass: "balanced",
    model: row.model || FISH_NATIVE_FREE_MODEL,
    recommendedForLongForm: true,
    supportsNativeStream: true,
    maxCharsPerRequest: 2200,
    usdPerMillionChars: 0,
    accentHint: "american",
    qualityNotes: "Your Fish Audio cloned voice.",
  };
  return enrichCatalogVoice(base);
}

export { isFishConfigured };
