import { directObjectUrl } from "@/lib/storage";

/**
 * Same test as `isSectionStoragePath` in `@/lib/tts/concat-audio`, repeated
 * here so the library and job routes do not pull ffmpeg/finalize code into
 * their bundles. `direct-download.test.ts` keeps the two in step.
 */
export function isSectionPath(path: string): boolean {
  return /\/sections\//.test(path);
}

/** `My Book!` → `my_book_.mp3`, matching `/api/jobs/[id]/download`. */
export function downloadFilename(bookTitle: unknown, storagePath: string): string {
  const safeTitle = String(bookTitle || "audiobook")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
  const ext = storagePath.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "mp3";
  return `${safeTitle}.${ext}`;
}

/**
 * Add `download_url`: a presigned R2 link that answers
 * `Content-Disposition: attachment` itself, so the browser saves the finished
 * book straight from R2. Streaming a 50 MB–3 GB `full.mp3` through
 * `/api/jobs/[id]/download` spent Vercel origin transfer on every save.
 *
 * Only a ready job with an assembled full file gets one. Anything else (still
 * generating, sections only, local dev, kill switch, presign error) keeps the
 * `/api/jobs/[id]/download` fallback, which concatenates sections.
 */
export async function withDirectDownloadUrl<T extends object>(
  serialized: T,
  job: Record<string, unknown>
): Promise<T & { download_url?: string }> {
  const storagePath = job.audio_storage_path;
  if (job.status !== "ready" || typeof storagePath !== "string" || !storagePath) {
    return serialized;
  }
  if (isSectionPath(storagePath)) return serialized;
  try {
    const url = await directObjectUrl(storagePath, {
      downloadName: downloadFilename(job.book_title, storagePath),
    });
    return url ? { ...serialized, download_url: url } : serialized;
  } catch (err) {
    console.warn(
      `[direct-download] presign failed for ${storagePath}:`,
      err instanceof Error ? err.message : err
    );
    return serialized;
  }
}
