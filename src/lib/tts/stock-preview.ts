import {
  coercePlainCatalogVoiceId,
  isSlimStockVoiceId,
} from "@/lib/tts/standard-voice";

/** Committed Edge takes of `PREVIEW_TEXT`. Served as static files. */
export const STOCK_PREVIEW_PUBLIC_DIR = "voice-previews";

/**
 * Public URL for a listed stock narrator's sample.
 * Clara resolves to Libby's file. Randolph resolves to Andrew's.
 * Safe to import from client components. The file reader lives in
 * `stock-preview-file.ts`.
 */
export function stockPreviewUrl(catalogVoiceId: string): string | null {
  const id = coercePlainCatalogVoiceId(catalogVoiceId);
  if (!isSlimStockVoiceId(id)) return null;
  return `/${STOCK_PREVIEW_PUBLIC_DIR}/${id}.mp3`;
}
