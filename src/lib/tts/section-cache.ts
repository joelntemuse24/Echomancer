/**
 * Content-addressed take-home section cache.
 *
 * Key = hash(section text + voice/reference_id + model + latency).
 * A retry or second generate of the same book skips Fish when the hash hits.
 * Failures here never block synthesis.
 */

import { createHash } from "crypto";
import { downloadFile, fileExists, uploadFile } from "@/lib/storage";

export function sectionCacheKey(opts: {
  text: string;
  voiceId: string;
  model: string;
  latency: string;
}): string {
  return createHash("sha256")
    .update(opts.text, "utf8")
    .update("\0")
    .update(opts.voiceId, "utf8")
    .update("\0")
    .update(opts.model, "utf8")
    .update("\0")
    .update(opts.latency, "utf8")
    .digest("hex");
}

function cachePath(key: string, extension: string): string {
  return `tts-cache/${key}.${extension}`;
}

export async function readSectionCache(
  key: string,
  extension: string
): Promise<Buffer | null> {
  const path = cachePath(key, extension);
  try {
    if (!(await fileExists(path))) return null;
    const buf = await downloadFile(path);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export async function writeSectionCache(
  key: string,
  extension: string,
  audio: Buffer,
  contentType: string
): Promise<void> {
  try {
    await uploadFile(
      "tts-cache",
      `${key}.${extension}`,
      audio,
      contentType
    );
  } catch (err) {
    console.warn(
      "[section-cache] write failed:",
      err instanceof Error ? err.message : err
    );
  }
}
