/**
 * Saved Expressive compare clips.
 *
 * Andrew / Michelle / Randolph Expressive, and Play both's Expressive side,
 * all synthesize the same fixed script. The first request stores the MP3.
 * Later taps read it and do not call Fish.
 *
 * Object key is sha256(revision, catalog id, Fish reference id, model, script).
 * A new `FISH_COMPARE_SCRIPT` or `FISH_TWIN_*_REF` misses and records a new
 * clip. Bump {@link EXPRESSIVE_PREVIEW_CACHE_REVISION} to force a new take
 * of the same words and reference. Old objects are left in place.
 *
 * Storage is R2 when configured, otherwise the local `STORAGE_PATH` tree.
 * The storage proxy does not serve `previews/` (no owning job), so playback
 * stays on `POST /api/tts/preview`.
 */

import { createHash } from "crypto";
import { downloadFile, uploadFile } from "@/lib/storage";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";

/**
 * Bump this when the saved take should be thrown away without changing
 * the compare script or the twin reference.
 */
export const EXPRESSIVE_PREVIEW_CACHE_REVISION = "clean-soft-tone-v1";

export function expressivePreviewObjectPath(key: string): string {
  return `previews/expressive/${key}.mp3`;
}

export function expressivePreviewCacheKey(opts: {
  catalogVoiceId: string;
  referenceId: string;
  model: string;
  script: string;
  revision?: string;
}): string {
  return createHash("sha256")
    .update(opts.revision ?? EXPRESSIVE_PREVIEW_CACHE_REVISION, "utf8")
    .update("\0")
    .update(opts.catalogVoiceId.trim().toLowerCase(), "utf8")
    .update("\0")
    .update(opts.referenceId.trim().toLowerCase(), "utf8")
    .update("\0")
    .update(opts.model.trim(), "utf8")
    .update("\0")
    .update(opts.script, "utf8")
    .digest("hex");
}

function isMpegContentType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.includes("mpeg") || type.includes("mp3");
}

/** Saved clip, or null on a miss, a silent object, or a storage error. */
export async function readExpressivePreviewCache(
  key: string
): Promise<Buffer | null> {
  try {
    const buf = await downloadFile(expressivePreviewObjectPath(key));
    if (!buf.length || isEmptyOrSilentAudio(buf)) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Store an audible MPEG clip. Silence and non-MPEG bodies are skipped.
 * A write failure leaves the caller free to return the fresh bytes.
 */
export async function writeExpressivePreviewCache(
  key: string,
  audio: Buffer,
  contentType: string
): Promise<boolean> {
  if (!audio.length || isEmptyOrSilentAudio(audio)) return false;
  if (!isMpegContentType(contentType)) return false;
  try {
    await uploadFile(
      "previews/expressive",
      `${key}.mp3`,
      audio,
      "audio/mpeg"
    );
    return true;
  } catch (err) {
    console.warn(
      "[expressive-preview-cache] write failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
