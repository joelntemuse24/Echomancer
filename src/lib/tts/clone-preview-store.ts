/**
 * Stored previews for saved Fish clone voices.
 *
 * A clone's short preview line is synthesized once, stored next to other
 * audio, and served from storage after that, the same way stock voices play a
 * baked file. Callers resolve the clone through the user-scoped catalog first,
 * so a user can only reach previews of their own clones.
 *
 * ## Two key families, on purpose
 *
 * `clone-preview-v1` is the **original** recipe: it hashed only the reference
 * id, model, speed and script — no engine name. Every clone preview rendered
 * before the S2-Pro pool existed used it, and those files are still in
 * storage. They are genuinely this clone's voice (Fish 2.1 Pro trained the
 * reference), so they are the *best* preview audio a voice can have: already
 * paid for, already on disk, and instantly playable.
 *
 * `clone-preview-v2` records the engine that actually rendered the take. That
 * is what stops a take from another engine ever being served as this clone's
 * preview — the 2026-11-06 incident, where a Drama 3 fallback render was
 * stored under an S2 key and then served as "the S2 preview".
 *
 * Lookup therefore tries, in order:
 *   1. the current engine's v2 key (`previews/clones/<row>/<hash>.mp3`),
 *   2. the legacy engine-free v1 key, i.e. the older Fish 2.1 MP3.
 *
 * Write always goes to the v2 key. Nothing is ever written to a key whose
 * engine name does not match the engine that produced the bytes.
 */

import { createHash } from "crypto";
import { downloadFile, uploadFile } from "@/lib/storage";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import {
  cloneRowIdFromCatalogId,
  isFishCloneCatalogId,
} from "@/lib/tts/fish-clone";

/**
 * The engine a preview was rendered by. Recorded in the key, so a take cannot
 * be served under a different engine's name.
 *
 * Only two values exist. Drama 3 is deliberately absent: it did not speak the
 * clone, so it has no preview key and its takes are never stored.
 */
export type ClonePreviewEngine = "s2-pro" | "fish";

/** Bump to regenerate every stored clone preview. */
export const CLONE_PREVIEW_RECIPE = "clone-preview-v2";

/**
 * The pre-engine recipe, kept only so previews rendered before the S2-Pro pool
 * existed are still found. Never write under this.
 *
 * Its files are the Fish 2.1 Pro takes for these voices — the same reference
 * model that trained the clone — so they are correct preview audio, not stale
 * leftovers. That is why they are preferred over re-rendering: a voice that
 * already has one plays instantly and costs nothing.
 */
export const LEGACY_CLONE_PREVIEW_RECIPE = "clone-preview-v1";

export const CLONE_PREVIEW_DIR = "previews/clones";

const SAFE_ROW_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type ClonePreviewKeyInput = {
  catalogVoiceId: string;
  providerVoiceId: string | null | undefined;
  model: string | null | undefined;
  /** Exact text sent to the engine. */
  script: string;
  speed: number | null | undefined;
};

function rowIdForClone(catalogVoiceId: string): string | null {
  if (!isFishCloneCatalogId(catalogVoiceId)) return null;
  const rowId = cloneRowIdFromCatalogId(catalogVoiceId);
  return rowId && SAFE_ROW_ID.test(rowId) ? rowId : null;
}

function hashKey(parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
}

function speedPart(speed: number | null | undefined): number {
  return typeof speed === "number" && Number.isFinite(speed) ? speed : 1;
}

/**
 * The key a take rendered by `engine` is stored under. This is the only key
 * anything may be written to.
 */
export function clonePreviewStoragePath(
  input: ClonePreviewKeyInput,
  engine: ClonePreviewEngine = "s2-pro"
): string | null {
  const rowId = rowIdForClone(input.catalogVoiceId);
  const reference = input.providerVoiceId?.trim();
  if (!rowId || !reference) return null;
  const hash = hashKey([
    `${CLONE_PREVIEW_RECIPE}-${engine}`,
    reference,
    input.model ?? "",
    speedPart(input.speed),
    input.script,
  ]);
  return `${CLONE_PREVIEW_DIR}/${rowId}/${hash}.mp3`;
}

/**
 * The engine-free key a pre-S2 preview lives under, if one was ever written.
 *
 * Reproduces the original recipe byte for byte, which is what makes the older
 * Fish 2.1 MP3s findable without a migration. Read-only by contract.
 */
export function legacyClonePreviewStoragePath(
  input: ClonePreviewKeyInput
): string | null {
  const rowId = rowIdForClone(input.catalogVoiceId);
  const reference = input.providerVoiceId?.trim();
  if (!rowId || !reference) return null;
  const hash = hashKey([
    LEGACY_CLONE_PREVIEW_RECIPE,
    reference,
    input.model ?? "",
    speedPart(input.speed),
    input.script,
  ]);
  return `${CLONE_PREVIEW_DIR}/${rowId}/${hash}.mp3`;
}

/**
 * Every key that may hold a usable preview for this clone, best first.
 *
 * The current engine's take wins, so a voice whose preview was re-rendered on
 * S2 plays that. Otherwise the legacy Fish 2.1 file is used — no Modal call,
 * no cold restore, no live synthesis just to preview a saved voice.
 */
export function clonePreviewLookupPaths(
  input: ClonePreviewKeyInput,
  engine: ClonePreviewEngine = "s2-pro"
): string[] {
  const current = clonePreviewStoragePath(input, engine);
  const legacy = legacyClonePreviewStoragePath(input);
  return [current, legacy].filter(
    (path, index, all): path is string =>
      Boolean(path) && all.indexOf(path) === index
  );
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

export type StoredClonePreview = { path: string; audio: Buffer };

/**
 * The first usable preview for this clone, with the key it came from.
 *
 * A legacy Fish 2.1 file is reported as found, not regenerated: it is this
 * voice on the model that trained it.
 */
export async function readFirstStoredClonePreview(
  input: ClonePreviewKeyInput,
  engine: ClonePreviewEngine = "s2-pro"
): Promise<StoredClonePreview | null> {
  for (const path of clonePreviewLookupPaths(input, engine)) {
    const audio = await readStoredClonePreview(path);
    if (audio) return { path, audio };
  }
  return null;
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
