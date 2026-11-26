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
 * Drew's take is `PREVIEW_TEXT` rendered with the stage A checkpoint
 * (`step00900_kmodel.pth` + `step00900_voice.pt`) at app speed 1.0.
 * The file on disk is Kokoro 0.88, style row 300, 24 kHz mono, which is
 * `DREW_NATIVE_KOKORO_SPEED`. Re-record it when that constant changes.
 *
 * Walter keeps the id `sowell`, so its file keeps the old name. Only the
 * listed label changed.
 */
export const COMMITTED_PREVIEW_IDS: readonly string[] = [
  ...SLIM_STOCK_VOICE_IDS,
  SOWELL_CATALOG_VOICE_ID,
];

/**
 * Public URL for a listed stock narrator's sample.
 *
 * Andrew and Echomancer Andrew resolve to Drew's catalog id because both
 * are retired and a request that names either lands on Drew. Ava's card
 * plays `ava.mp3` and Libby's plays `libby.mp3` while those cards are
 * listed. The preview API serves Esther's file for those ids only once
 * her endpoint is set. Walter resolves through its unchanged `sowell` id.
 * Esther and George each have their own committed take.
 * Safe to import from client components. The file reader lives in
 * `stock-preview-file.ts`.
 */
export function stockPreviewUrl(catalogVoiceId: string): string | null {
  const id = coercePlainCatalogVoiceId(catalogVoiceId);
  if (!isSlimStockVoiceId(id) && id !== SOWELL_CATALOG_VOICE_ID) return null;
  if (!COMMITTED_PREVIEW_IDS.includes(id)) return null;
  return `/${STOCK_PREVIEW_PUBLIC_DIR}/${id}.mp3`;
}
