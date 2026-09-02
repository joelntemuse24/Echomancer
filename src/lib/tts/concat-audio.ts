/**
 * Concatenate take-home audio segments into a single playable file.
 */
import { downloadFile, uploadFile } from "@/lib/storage";
import type { JobSegment } from "@/lib/tts/types";
import {
  createWavHeader,
  isRawPcmContentType,
  stripWavHeader,
} from "@/lib/tts/pcm-wav";
import { allIndexesReady, readyCount } from "@/lib/tts/section-index";

export type AudioFormat = {
  extension: "mp3" | "wav" | "ogg";
  contentType: string;
};

export function getSegmentFormat(segment: JobSegment): AudioFormat | null {
  const contentType = segment.contentType?.split(";", 1)[0]?.toLowerCase();
  if (contentType === "audio/mpeg" || contentType === "audio/mp3") {
    return { extension: "mp3", contentType: "audio/mpeg" };
  }
  if (
    contentType === "audio/wav" ||
    contentType === "audio/x-wav" ||
    contentType === "audio/pcm" ||
    contentType === "audio/l16"
  ) {
    return { extension: "wav", contentType: "audio/wav" };
  }
  if (contentType === "audio/ogg" || contentType === "application/ogg") {
    return { extension: "ogg", contentType: "audio/ogg" };
  }

  const extension = segment.path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension === "mp3") return { extension, contentType: "audio/mpeg" };
  if (extension === "wav" || extension === "pcm") {
    return { extension: "wav", contentType: "audio/wav" };
  }
  if (extension === "ogg") return { extension, contentType: "audio/ogg" };
  return null;
}

export function readySegmentsSorted(segments: JobSegment[]): JobSegment[] {
  return segments
    .filter((s) => s.status === "ready" && s.path)
    .sort((a, b) => a.index - b.index);
}

/** True when storage path is a single section, not a full-book artifact. */
export function isSectionStoragePath(path: string | null | undefined): boolean {
  return Boolean(path && /\/sections\//.test(path));
}

export async function concatReadySegments(
  segments: JobSegment[],
  logPrefix = "[concat]",
  opts?: { total?: number; requireAllIndexes?: boolean }
): Promise<{ buffer: Buffer; format: AudioFormat } | null> {
  const total = opts?.total;
  if (
    opts?.requireAllIndexes &&
    (total === undefined || !allIndexesReady(segments, total))
  ) {
    console.error(
      `${logPrefix} Refusing concat until every index is ready (have ${readyCount(segments)}/${total ?? "?"})`
    );
    return null;
  }

  const ready = readySegmentsSorted(segments);
  if (ready.length === 0) return null;

  if (total !== undefined && total > 0) {
    for (let i = 0; i < total; i++) {
      if (ready[i]?.index !== i) {
        console.error(
          `${logPrefix} Refusing concat: gap at index ${i} (playlist is index order)`
        );
        return null;
      }
    }
  }

  const format = getSegmentFormat(ready[0]!);
  if (
    !format ||
    ready.some((s) => getSegmentFormat(s)?.extension !== format.extension)
  ) {
    console.error(`${logPrefix} Mixed or unsupported segment formats`);
    return null;
  }

  const parts: Buffer[] = [];
  for (const seg of ready) {
    try {
      const buf = await downloadFile(seg.path);
      if (format.extension === "wav") {
        if (isRawPcmContentType(seg.contentType) || seg.path.endsWith(".pcm")) {
          parts.push(buf);
        } else {
          parts.push(Buffer.from(stripWavHeader(buf)));
        }
      } else {
        parts.push(buf);
      }
    } catch (err) {
      console.error(`${logPrefix} Failed to read segment ${seg.index}:`, err);
    }
  }

  if (parts.length === 0) return null;

  if (format.extension === "wav") {
    const pcm = Buffer.concat(parts);
    return {
      buffer: Buffer.concat([createWavHeader(pcm.length), pcm]),
      format,
    };
  }

  return { buffer: Buffer.concat(parts), format };
}

/**
 * Build and upload a single full-book file. Returns the storage path.
 */
export async function materializeFullAudiobook(
  jobId: string,
  segments: JobSegment[],
  total?: number
): Promise<string | null> {
  const expected = total ?? readySegmentsSorted(segments).length;
  const built = await concatReadySegments(
    segments,
    `[Job ${jobId} finalize]`,
    { total: expected, requireAllIndexes: true }
  );
  if (!built) return null;

  const uploaded = await uploadFile(
    `audiobooks/${jobId}`,
    `full.${built.format.extension}`,
    built.buffer,
    built.format.contentType
  );
  console.log(
    `[Job ${jobId}] wrote full audiobook ${uploaded.path} (${built.buffer.length} bytes, ${readySegmentsSorted(segments).length} sections)`
  );
  return uploaded.path;
}
