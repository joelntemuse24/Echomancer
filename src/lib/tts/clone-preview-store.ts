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
 *   1. the fish v2 key — every new bake is stored here,
 *   2. the legacy engine-free v1 key, i.e. the older Fish 2.1 MP3,
 *   3. an older s2-pro v2 key, if one was written before bakes moved to fish.
 *
 * A clip that exists is one read when it is a fish bake, and the next read
 * when it is a legacy file. Write always goes to the fish v2 key. Nothing is
 * ever written to a key whose engine name does not match the engine that
 * produced the bytes.
 */

import { createHash } from "crypto";
import { downloadFile, readObjectStat, uploadFile } from "@/lib/storage";
import { isEmptyOrSilentAudio, MIN_AUDIBLE_BYTES } from "@/lib/tts/audio-guard";
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
 * All of these are **this voice**: `s2-pro` and `fish` both speak the reference
 * Fish trained, and the legacy v1 object is a Fish 2.1 Pro take. Drama 3 has no
 * key here at all, so a take from it can never be found — that is the point.
 *
 * Fish first: that is the key a new bake writes, so a stored clip is one
 * read. Legacy v1 is next, for clones baked before the engine suffix.
 * s2-pro is last. It is still this voice, and it is still found. The
 * `engine` argument is kept so callers do not change; it does not reorder
 * the reads.
 */
export function clonePreviewLookupPaths(
  input: ClonePreviewKeyInput,
  engine: ClonePreviewEngine = "fish"
): string[] {
  void engine;
  const candidates = [
    clonePreviewStoragePath(input, "fish"),
    legacyClonePreviewStoragePath(input),
    clonePreviewStoragePath(input, "s2-pro"),
  ];
  return candidates.filter(
    (path, index, all): path is string =>
      Boolean(path) && all.indexOf(path) === index
  );
}

/**
 * Short cache key for a stored clip.
 *
 * The recipe and the object key are both in the hash, so a recipe bump or a
 * different file (fish, legacy, s2-pro) is a different URL.
 */
export function clonePreviewVersionToken(storagePath: string): string {
  return createHash("sha256")
    .update(CLONE_PREVIEW_RECIPE)
    .update("\0")
    .update(storagePath)
    .digest("hex")
    .slice(0, 16);
}

/** Same-origin URL the picker can play and the browser can cache. */
export function clonePreviewPublicUrl(
  catalogVoiceId: string,
  storagePath: string
): string {
  return `/api/tts/clones/${encodeURIComponent(catalogVoiceId)}/preview?v=${clonePreviewVersionToken(storagePath)}`;
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
  engine: ClonePreviewEngine = "fish"
): Promise<StoredClonePreview | null> {
  for (const path of clonePreviewLookupPaths(input, engine)) {
    const audio = await readStoredClonePreview(path);
    if (audio) return { path, audio };
  }
  return null;
}

export type LocatedClonePreview =
  | { path: string }
  | "miss"
  | "error";

/**
 * The first key that already holds a clip, without downloading it.
 *
 * `"miss"` means every candidate was absent or too small. `"error"` means
 * storage could not be read, so the caller must not remember a miss.
 * A silent object can still be large enough to count; the preview route
 * is what refuses to serve it. This does not bake.
 */
export async function locateClonePreview(
  input: ClonePreviewKeyInput,
  engine: ClonePreviewEngine = "fish"
): Promise<LocatedClonePreview> {
  let sawError = false;
  for (const path of clonePreviewLookupPaths(input, engine)) {
    try {
      const stat = await readObjectStat(path);
      if (stat && stat.size >= MIN_AUDIBLE_BYTES) return { path };
    } catch {
      sawError = true;
    }
  }
  return sawError ? "error" : "miss";
}

/**
 * The first key that already holds a clip, without downloading it.
 * A storage error is a miss for callers that only need a path.
 */
export async function findExistingClonePreviewPath(
  input: ClonePreviewKeyInput,
  engine: ClonePreviewEngine = "fish"
): Promise<string | null> {
  const located = await locateClonePreview(input, engine);
  return located === "miss" || located === "error" ? null : located.path;
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
