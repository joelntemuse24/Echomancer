/**
 * Concatenate take-home audio segments into a single playable file.
 *
 * Compressed sections are remuxed (decode → PCM join → loudnorm → one MP3).
 * Byte-gluing MP3/Ogg frames is never the success path.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadFile, uploadFile } from "@/lib/storage";
import type { JobSegment, SectionJoinKind } from "@/lib/tts/types";
import {
  ConcatAssembleError,
  concatPcm16MonoWithCrossfade,
  clampCrossfadeMs,
  ffmpegConcatAvailable,
  resolveConcatCrossfadeMs,
} from "@/lib/tts/crossfade-audio";
import {
  createWavHeader,
  isRawPcmContentType,
  PCM_DEFAULTS,
  readWavSampleRate,
  stripWavHeader,
} from "@/lib/tts/pcm-wav";
import { allIndexesReady, readyCount } from "@/lib/tts/section-index";
import {
  applyFullBookMastering,
  MASTER_LOUDNORM_I,
  MASTER_LOUDNORM_TP,
  type MasterEnhanceFn,
} from "@/lib/tts/mastering";

export { ConcatAssembleError };

const OUTPUT_SAMPLE_RATE = 44_100;
const OUTPUT_MP3_BITRATE = "192k";

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

function fadeMsForJoin(
  joinKind: SectionJoinKind | undefined,
  defaultMs: number
): number {
  if (joinKind === "mid-paragraph") return 0;
  if (joinKind === "chapter") return Math.max(defaultMs, 80);
  return clampCrossfadeMs(defaultMs);
}

function resolveFfmpegBin(): string | null {
  if (!ffmpegConcatAvailable()) return null;
  const explicit = process.env.FFMPEG_PATH || process.env.TTS_FFMPEG_PATH;
  return explicit || "ffmpeg";
}

async function runFfmpeg(args: string[], timeoutMs = 180_000): Promise<void> {
  const bin = resolveFfmpegBin();
  if (!bin) throw new ConcatAssembleError("ffmpeg is not available on this host");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out: ${stderr.slice(0, 300)}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

/** Decode one compressed/WAV section to 44.1 kHz mono s16le WAV. */
export async function decodeSectionToWav(input: Buffer, ext: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "ec-decode-"));
  try {
    const src = path.join(dir, `in.${ext}`);
    const out = path.join(dir, "out.wav");
    await writeFile(src, input);
    await runFfmpeg([
      "-y",
      "-i",
      src,
      "-ac",
      "1",
      "-ar",
      String(OUTPUT_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Encode PCM WAV → 44.1 kHz ~192 kbps MP3 with loudnorm. */
export async function encodeWavToMp3(wav: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "ec-encode-"));
  try {
    const src = path.join(dir, "in.wav");
    const out = path.join(dir, "out.mp3");
    await writeFile(src, wav);
    await runFfmpeg([
      "-y",
      "-i",
      src,
      "-af",
      `loudnorm=I=${MASTER_LOUDNORM_I}:TP=${MASTER_LOUDNORM_TP}`,
      "-ar",
      String(OUTPUT_SAMPLE_RATE),
      "-b:a",
      OUTPUT_MP3_BITRATE,
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  if (items.length === 0) return out;
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}

export type RemuxFn = (
  parts: Buffer[],
  joins: SectionJoinKind[],
  fadeMs: number
) => Promise<Buffer>;

/**
 * Decode compressed sections to PCM, crossfade at joins, loudnorm, encode MP3.
 * Never returns `Buffer.concat` of the source frames.
 */
export async function remuxCompressedSections(
  parts: Buffer[],
  extension: "mp3" | "ogg" | "wav",
  joins: SectionJoinKind[],
  fadeMs: number
): Promise<Buffer> {
  if (parts.length === 0) {
    throw new ConcatAssembleError("no sections to remux");
  }
  if (parts.length === 1) {
    const wav =
      extension === "wav"
        ? parts[0]!
        : await decodeSectionToWav(parts[0]!, extension);
    return encodeWavToMp3(wav);
  }

  const pcmParts: Buffer[] = [];
  const wavs = await mapPool(parts, 3, async (part) =>
    extension === "wav" ? part : decodeSectionToWav(part, extension)
  );
  for (const wav of wavs) {
    pcmParts.push(Buffer.from(stripWavHeader(wav)));
  }

  const defaultFade = clampCrossfadeMs(fadeMs);
  let acc = pcmParts[0]!;
  for (let i = 1; i < pcmParts.length; i++) {
    const join = joins[i] ?? "paragraph";
    const ms = fadeMsForJoin(join, defaultFade);
    if (ms <= 0) {
      acc = Buffer.concat([acc, pcmParts[i]!]);
    } else {
      acc = concatPcm16MonoWithCrossfade(
        [acc, pcmParts[i]!],
        OUTPUT_SAMPLE_RATE,
        ms
      );
    }
  }

  const wav = Buffer.concat([
    createWavHeader(acc.length, { sampleRate: OUTPUT_SAMPLE_RATE }),
    acc,
  ]);
  return encodeWavToMp3(wav);
}

async function zipSectionBuffers(
  parts: { index: number; buffer: Buffer; ext: string }[]
): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const part of parts) {
    zip.file(
      `sections/${String(part.index).padStart(4, "0")}.${part.ext}`,
      part.buffer
    );
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

export async function concatReadySegments(
  segments: JobSegment[],
  logPrefix = "[concat]",
  opts?: {
    total?: number;
    requireAllIndexes?: boolean;
    allowHoles?: boolean;
    crossfadeMs?: number;
    joinKinds?: Array<SectionJoinKind | undefined>;
    remux?: RemuxFn;
  }
): Promise<{ buffer: Buffer; format: AudioFormat } | null> {
  const total = opts?.total;
  if (
    opts?.requireAllIndexes &&
    !opts.allowHoles &&
    (total === undefined || !allIndexesReady(segments, total))
  ) {
    console.error(
      `${logPrefix} Refusing concat until every index is ready (have ${readyCount(segments)}/${total ?? "?"})`
    );
    return null;
  }

  const ready = readySegmentsSorted(segments);
  if (ready.length === 0) return null;

  if (!opts?.allowHoles && total !== undefined && total > 0) {
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
  let wavSampleRate: number = PCM_DEFAULTS.sampleRate;
  for (const seg of ready) {
    try {
      const buf = await downloadFile(seg.path);
      if (format.extension === "wav") {
        if (isRawPcmContentType(seg.contentType) || seg.path.endsWith(".pcm")) {
          parts.push(buf);
        } else {
          if (parts.length === 0) wavSampleRate = readWavSampleRate(buf);
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

  const fadeMs =
    typeof opts?.crossfadeMs === "number"
      ? opts.crossfadeMs
      : resolveConcatCrossfadeMs();

  const joins: SectionJoinKind[] = ready.map(
    (seg) => opts?.joinKinds?.[seg.index] ?? "paragraph"
  );

  if (format.extension === "wav" && parts.length === 1) {
    return {
      buffer: Buffer.concat([
        createWavHeader(parts[0]!.length, { sampleRate: wavSampleRate }),
        parts[0]!,
      ]),
      format,
    };
  }

  if (format.extension === "wav") {
    const pcm = concatPcm16MonoWithCrossfade(parts, wavSampleRate, fadeMs);
    return {
      buffer: Buffer.concat([
        createWavHeader(pcm.length, { sampleRate: wavSampleRate }),
        pcm,
      ]),
      format,
    };
  }

  if (parts.length === 1) {
    return { buffer: parts[0]!, format };
  }

  const remux: RemuxFn =
    opts?.remux ??
    ((p, j, ms) => remuxCompressedSections(p, format.extension, j, ms));
  if (ffmpegConcatAvailable() || opts?.remux) {
    try {
      const remuxed = await remux(parts, joins, fadeMs);
      if (remuxed?.length) {
        return { buffer: remuxed, format: { extension: "mp3", contentType: "audio/mpeg" } };
      }
    } catch (err) {
      console.error(
        `${logPrefix} remux failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.error(
    `${logPrefix} Refusing byte-glued ${format.extension}; ffmpeg remux unavailable`
  );
  throw new ConcatAssembleError(
    "Cannot assemble full.mp3 without ffmpeg remux (byte-glue disabled)"
  );
}

/**
 * Build and upload a single full-book file. Returns the storage path.
 *
 * Concat + loudnorm first, then upload a playable `full.*` so Make→ready
 * does not wait on DeepFilter. DFN mastering stays fail-open and overwrites
 * the same object when it finishes.
 */
export async function materializeFullAudiobook(
  jobId: string,
  segments: JobSegment[],
  total?: number,
  opts?: {
    alreadyMastered?: boolean;
    enhance?: MasterEnhanceFn;
    crossfadeMs?: number;
    allowHoles?: boolean;
    joinKinds?: Array<SectionJoinKind | undefined>;
    remux?: RemuxFn;
    /** Fired after the dry concat is on storage, before DFN remaster. */
    onDryUploaded?: (path: string) => Promise<void>;
  }
): Promise<string | null> {
  const expected = total ?? readySegmentsSorted(segments).length;
  let built: { buffer: Buffer; format: AudioFormat } | null = null;
  try {
    built = await concatReadySegments(
      segments,
      `[Job ${jobId} finalize]`,
      {
        total: expected,
        requireAllIndexes: !opts?.allowHoles,
        allowHoles: opts?.allowHoles,
        crossfadeMs: opts?.crossfadeMs,
        joinKinds: opts?.joinKinds,
        remux: opts?.remux,
      }
    );
  } catch (err) {
    if (err instanceof ConcatAssembleError && opts?.allowHoles) {
      console.warn(`[Job ${jobId}] remux failed with holes — shipping section zip`);
      return zipAndUploadSections(jobId, segments);
    }
    if (err instanceof ConcatAssembleError) {
      console.error(`[Job ${jobId}] assemble failed:`, err.message);
      try {
        return await zipAndUploadSections(jobId, segments);
      } catch (zipErr) {
        console.error(`[Job ${jobId}] section zip also failed:`, zipErr);
        return null;
      }
    }
    throw err;
  }
  if (!built) return null;

  const dry = await uploadFile(
    `audiobooks/${jobId}`,
    `full.${built.format.extension}`,
    built.buffer,
    built.format.contentType
  );
  console.log(
    `[Job ${jobId}] wrote dry audiobook ${dry.path} (${built.buffer.length} bytes, ${readySegmentsSorted(segments).length} sections)`
  );
  if (opts?.onDryUploaded) {
    await opts.onDryUploaded(dry.path);
  }

  const mastered = await applyFullBookMastering(built.buffer, built.format, {
    alreadyMastered: opts?.alreadyMastered,
    enhance: opts?.enhance,
    logPrefix: `[Job ${jobId}]`,
  });
  if (mastered.mastered && !mastered.buffer.equals(built.buffer)) {
    await uploadFile(
      `audiobooks/${jobId}`,
      `full.${built.format.extension}`,
      mastered.buffer,
      built.format.contentType
    );
    console.log(
      `[Job ${jobId}] overwrote full audiobook ${dry.path} after remaster (${mastered.buffer.length} bytes)`
    );
  } else {
    console.log(
      `[Job ${jobId}] remaster skipped or identical (${mastered.reason})`
    );
  }
  return dry.path;
}

async function zipAndUploadSections(
  jobId: string,
  segments: JobSegment[]
): Promise<string | null> {
  const ready = readySegmentsSorted(segments);
  if (ready.length === 0) return null;
  const parts: { index: number; buffer: Buffer; ext: string }[] = [];
  for (const seg of ready) {
    try {
      const buf = await downloadFile(seg.path);
      const ext = getSegmentFormat(seg)?.extension ?? "mp3";
      parts.push({ index: seg.index, buffer: buf, ext });
    } catch {
      /* skip unreadable */
    }
  }
  if (parts.length === 0) return null;
  const zip = await zipSectionBuffers(parts);
  const uploaded = await uploadFile(
    `audiobooks/${jobId}`,
    "sections.zip",
    zip,
    "application/zip"
  );
  console.log(
    `[Job ${jobId}] shipped section zip ${uploaded.path} (${parts.length} sections) because remux was unavailable`
  );
  return uploaded.path;
}
