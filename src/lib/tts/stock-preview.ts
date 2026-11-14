import { SOWELL_CATALOG_VOICE_ID } from "@/lib/tts/sowell-id";
import {
  coercePlainCatalogVoiceId,
  isSlimStockVoiceId,
  SLIM_STOCK_VOICE_IDS,
} from "@/lib/tts/standard-voice";

/** Committed takes of `PREVIEW_TEXT`. Served as static files. */
export const STOCK_PREVIEW_PUBLIC_DIR = "voice-previews";

/**
 * Ids that actually have a committed file at `public/voice-previews/<id>.mp3`.
 *
 * **TODO (owner/bot):** Drew has no committed take yet. Render
 * `PREVIEW_TEXT` with the Drew checkpoint (`step00900_kmodel.pth` +
 * `step00900_voice.pt`, Kokoro speed 0.88, 24 kHz mono) and commit it as
 * `public/voice-previews/drew.mp3`, then add `"drew"` here. Until then the
 * picker falls through to `POST /api/tts/preview`, which renders Drew once
 * on the CPU app instead of playing a missing static file.
 *
 * Walter keeps the id `sowell`, so its file keeps the old name. Only the
 * listed label changed.
 */
export const COMMITTED_PREVIEW_IDS: readonly string[] = [
  ...SLIM_STOCK_VOICE_IDS,
  SOWELL_CATALOG_VOICE_ID,
].filter((id) => id !== "drew");

/**
 * Public URL for a listed stock narrator's sample.
 *
 * Andrew resolves to Drew's catalog id because Andrew is retired and a
 * request that names him lands on Drew. Walter resolves through its unchanged
 * `sowell` id. Echomancer Andrew and George have their own committed takes.
 * Safe to import from client components. The file reader lives in
 * `stock-preview-file.ts`.
 */
export function stockPreviewUrl(catalogVoiceId: string): string | null {
  const id = coercePlainCatalogVoiceId(catalogVoiceId);
  if (!isSlimStockVoiceId(id) && id !== SOWELL_CATALOG_VOICE_ID) return null;
  if (!COMMITTED_PREVIEW_IDS.includes(id)) return null;
  return `/${STOCK_PREVIEW_PUBLIC_DIR}/${id}.mp3`;
}
