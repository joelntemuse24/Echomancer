import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  coercePlainCatalogVoiceId,
  isSlimStockVoiceId,
} from "@/lib/tts/standard-voice";

/** Committed Edge takes of `PREVIEW_TEXT`. Served as static files. */
export const STOCK_PREVIEW_PUBLIC_DIR = "voice-previews";

/**
 * Public URL for a listed stock narrator's sample.
 * Clara resolves to Libby's file. Randolph resolves to Ryan's.
 */
export function stockPreviewUrl(catalogVoiceId: string): string | null {
  const id = coercePlainCatalogVoiceId(catalogVoiceId);
  if (!isSlimStockVoiceId(id)) return null;
  return `/${STOCK_PREVIEW_PUBLIC_DIR}/${id}.mp3`;
}

/** Bytes for a listed stock sample, or null when this id has no recording. */
export async function readStockPreview(
  catalogVoiceId: string
): Promise<Buffer | null> {
  const url = stockPreviewUrl(catalogVoiceId);
  if (!url) return null;
  try {
    return await readFile(path.join(process.cwd(), "public", url));
  } catch {
    return null;
  }
}
