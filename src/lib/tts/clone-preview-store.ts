/**
 * Stored previews for saved Fish clone voices.
 *
 * A clone's short preview line is synthesized once (on its first play),
 * stored next to other audio, and served from storage after that, the same
 * way stock voices play a baked file. The storage key hashes everything that
 * changes the audio (Fish reference id, model, speed and the exact script),
 * so a new reference or model gets a fresh file and the old one is never
 * served for it. Callers resolve the clone through the user-scoped catalog
 * first, so a user can only reach previews of their own clones.
 */

import { createHash } from "crypto";
import { downloadFile, uploadFile } from "@/lib/storage";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import {
  cloneRowIdFromCatalogId,
  isFishCloneCatalogId,
} from "@/lib/tts/fish-clone";

/** Bump to regenerate every stored clone preview. */
export const CLONE_PREVIEW_RECIPE = "clone-preview-v1";
export const CLONE_PREVIEW_DIR = "previews/clones";

const SAFE_ROW_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type ClonePreviewKeyInput = {
  catalogVoiceId: string;
  providerVoiceId: string | null | undefined;
  model: string | null | undefined;
  /** Exact text sent to Fish. */
  script: string;
  speed: number | null | undefined;
};

export function clonePreviewStoragePath(
  input: ClonePreviewKeyInput
): string | null {
  if (!isFishCloneCatalogId(input.catalogVoiceId)) return null;
  const rowId = cloneRowIdFromCatalogId(input.catalogVoiceId);
  const reference = input.providerVoiceId?.trim();
  if (!rowId || !SAFE_ROW_ID.test(rowId) || !reference) return null;
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        CLONE_PREVIEW_RECIPE,
        reference,
        input.model ?? "",
        typeof input.speed === "number" && Number.isFinite(input.speed)
          ? input.speed
          : 1,
        input.script,
      ])
    )
    .digest("hex")
    .slice(0, 32);
  return `${CLONE_PREVIEW_DIR}/${rowId}/${hash}.mp3`;
}

/** The stored preview, or null when there is none yet (or it is unusable). */
export async function readStoredClonePreview(
  storagePath: string
): Promise<Buffer | null> {
  try {
    const audio = await downloadFile(storagePath);
    return isEmptyOrSilentAudio(audio) ? null : audio;
  } catch {
    return null;
  }
}

/** Store a finished preview. Never throws; returns whether it was written. */
export async function storeClonePreview(
  storagePath: string,
  audio: Buffer
): Promise<boolean> {
  if (isEmptyOrSilentAudio(audio)) return false;
  const slash = storagePath.lastIndexOf("/");
  try {
    await uploadFile(
      storagePath.slice(0, slash),
      storagePath.slice(slash + 1),
      audio,
      "audio/mpeg"
    );
    return true;
  } catch (err) {
    console.warn(
      "[clone-preview] store failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
