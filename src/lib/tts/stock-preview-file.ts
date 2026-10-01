import { readFile } from "node:fs/promises";
import path from "node:path";
import { stockPreviewUrl } from "@/lib/tts/stock-preview";

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
