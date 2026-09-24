/**
 * Concatenate take-home audio segments into a single playable file.
 *
 * Compressed sections are remuxed (decode → PCM join → one delivery MP3).
 * The podcast chain runs on that encode. A second remaster is skipped
 * unless DeepFilter is opted in. Byte-gluing MP3/Ogg frames is never
 * the success path.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile, downloadFileToPath, uploadFile, uploadFileFromPath } from "@/lib/storage";
import { ensureJobScratchRoot } from "@/lib/tts/job-scratch";
import { streamFinalizeAudiobook, spawnFfmpeg } from "@/lib/tts/stream-finalize";
import type { JobSegment, SectionJoinKind } from "@/lib/tts/types";
import {
  ConcatAssembleError,
  concatPcm16MonoWithCrossfade,
  clampCrossfadeMs,
  crossfadePcm16Mono,
  ffmpegConcatAvailable,
  resolveConcatCrossfadeMs,
  resolveJoinFadeMs,
  trimPcm16EdgeSilence,
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
  MASTER_OUTPUT_MP3_BITRATE,
  MASTER_OUTPUT_SAMPLE_RATE,
  masterDenoiseWet,
  masterLoudnormAf,
  masterProfessionalAf,
  type MasterEnhanceFn,
} from "@/lib/tts/mastering";

export { ConcatAssembleError };

const OUTPUT_SAMPLE_RATE = MASTER_OUTPUT_SAMPLE_RATE;
const OUTPUT_MP3_BITRATE = MASTER_OUTPUT_MP3_BITRATE;
/** Full-book encode budget. Section decodes stay on the shorter default. */
const DELIVERY_ENCODE_TIMEOUT_MS = 20 * 60 * 1000;

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
  const dir = await mkdtemp(path.join(await ensureJobScratchRoot(), "ec-decode-"));
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

export type DeliveryEncode = {
  buffer: Buffer;
  /** True when the podcast chain (not a loudnorm-only fallback) was applied. */
  deliveryMastered: boolean;
};

/**
 * Encode joined PCM to 44.1 kHz ~192 kbps MP3.
 *
 * `delivery` runs the podcast chain in this one encode (the default
 * Whole-book path). `join` is the DeepFilter opt-in prep: no tonal
 * chain, so the later pass is the only EQ / loudnorm. `loudnorm` is
 * `TTS_MASTER_SKIP=1`: level the file and leave the spectral chain off.
 */
export async function encodeWavToMp3(
  wav: Buffer,
  mode: "delivery" | "join" | "loudnorm" = "delivery"
): Promise<DeliveryEncode> {
  const dir = await mkdtemp(path.join(await ensureJobScratchRoot(), "ec-encode-"));
  const started = Date.now();
  try {
    const src = path.join(dir, "in.wav");
    await writeFile(src, wav);
    const encode = async (af: string | null, outName: string) => {
      const out = path.join(dir, outName);
      const args = ["-y", "-i", src, "-ac", "1"];
      if (af) args.push("-af", af);
      args.push(
        "-ar",
        String(OUTPUT_SAMPLE_RATE),
        "-c:a",
        "libmp3lame",
        "-b:a",
        OUTPUT_MP3_BITRATE,
        out
      );
      await runFfmpeg(args, DELIVERY_ENCODE_TIMEOUT_MS);
      return readFile(out);
    };

    if (mode === "join") {
      const buffer = await encode(null, "out.mp3");
      console.log(
        `[concat] join encode ${Date.now() - started}ms (${buffer.length} bytes)`
      );
      return { buffer, deliveryMastered: false };
    }

    if (mode === "loudnorm") {
      const buffer = await encode(masterLoudnormAf(), "out.mp3");
      console.log(
        `[concat] loudnorm encode ${Date.now() - started}ms (${buffer.length} bytes)`
      );
      return { buffer, deliveryMastered: false };
    }

    try {
      const buffer = await encode(masterProfessionalAf(), "out.mp3");
      console.log(
        `[concat] delivery encode ${Date.now() - started}ms (${buffer.length} bytes)`
      );
      return { buffer, deliveryMastered: true };
    } catch (err) {
      console.warn(
        "[concat] delivery chain failed, loudnorm-only encode:",
        err instanceof Error ? err.message : err
      );
      const buffer = await encode(masterLoudnormAf(), "fallback.mp3");
      console.log(
        `[concat] loudnorm fallback encode ${Date.now() - started}ms (${buffer.length} bytes)`
      );
      return { buffer, deliveryMastered: false };
    }
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

export type RemuxedAudio = DeliveryEncode;

/**
 * Decode compressed sections to PCM, crossfade at joins, encode one MP3.
 * Never returns `Buffer.concat` of the source frames.
 */
export async function remuxCompressedSections(
  parts: Buffer[],
  extension: "mp3" | "ogg" | "wav",
  joins: SectionJoinKind[],
  fadeMs: number
): Promise<RemuxedAudio> {
  if (parts.length === 0) {
    throw new ConcatAssembleError("no sections to remux");
  }
  const encodeMode =
    process.env.TTS_MASTER_SKIP === "1"
      ? "loudnorm"
      : masterDenoiseWet() > 0
        ? "join"
        : "delivery";
  if (parts.length === 1) {
    const wav =
      extension === "wav"
        ? parts[0]!
        : await decodeSectionToWav(parts[0]!, extension);
    return encodeWavToMp3(wav, encodeMode);
  }

  const pcmParts: Buffer[] = [];
  const wavs = await mapPool(parts, 3, async (part) =>
    extension === "wav" ? part : decodeSectionToWav(part, extension)
  );
  for (const wav of wavs) {
    pcmParts.push(Buffer.from(stripWavHeader(wav)));
  }

  const defaultFade = clampCrossfadeMs(fadeMs);
  const trimmed =
    defaultFade > 0
      ? pcmParts.map((part) => trimPcm16EdgeSilence(part, OUTPUT_SAMPLE_RATE))
      : pcmParts;
  let acc = trimmed[0]!;
  for (let i = 1; i < trimmed.length; i++) {
    const fade = resolveJoinFadeMs(joins[i], defaultFade);
    if (fade.ms <= 0) {
      acc = Buffer.concat([acc, trimmed[i]!]);
    } else {
      acc = crossfadePcm16Mono(
        acc,
        trimmed[i]!,
        OUTPUT_SAMPLE_RATE,
        fade.ms,
        { clamp: fade.clamp }
      );
    }
  }

  const wav = Buffer.concat([
    createWavHeader(acc.length, { sampleRate: OUTPUT_SAMPLE_RATE }),
    acc,
  ]);
  return encodeWavToMp3(wav, encodeMode);
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
): Promise<{
  buffer: Buffer;
  format: AudioFormat;
  /** Podcast chain already ran on this encode, so a second pass would only add a generation of MP3. */
  deliveryMastered?: boolean;
} | null> {
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

  let deliveryMastered = false;
  const remux: RemuxFn =
    opts?.remux ??
    (async (p, j, ms) => {
      const out = await remuxCompressedSections(p, format.extension, j, ms);
      deliveryMastered = out.deliveryMastered;
      return out.buffer;
    });
  if (ffmpegConcatAvailable() || opts?.remux) {
    try {
      const remuxed = await remux(parts, joins, fadeMs);
      if (remuxed?.length) {
        return {
          buffer: remuxed,
          format: { extension: "mp3", contentType: "audio/mpeg" },
          deliveryMastered: opts?.remux ? false : deliveryMastered,
        };
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
 * Multi-section MP3/Ogg is one delivery encode (podcast chain included).
 * That file is uploaded and the job can be marked ready immediately. A
 * second pass runs only for DeepFilter opt-in, a raw single section, or
 * WAV joins that were not encoded here. Enhance errors still ship the
 * uploaded file.
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
    /** Fired after the playable full file is on storage, before any second pass. */
    onDryUploaded?: (path: string) => Promise<void>;
  }
): Promise<string | null> {
  const expected = total ?? readySegmentsSorted(segments).length;
  if (!opts?.remux && !opts?.enhance && ffmpegConcatAvailable()) {
    const ready = readySegmentsSorted(segments);
    const format = ready[0] ? getSegmentFormat(ready[0]) : null;
    if (
      format &&
      ready.every((segment) => getSegmentFormat(segment)?.extension === format.extension) &&
      (opts?.allowHoles ||
        expected <= 0 ||
        (ready.length === expected && ready.every((segment, index) => segment.index === index)))
    ) {
      const fadeMs =
        typeof opts?.crossfadeMs === "number" ? opts.crossfadeMs : resolveConcatCrossfadeMs();
      try {
        const streamed = await streamFinalizeAudiobook(
          jobId,
          ready.map((segment) => ({
            storagePath: segment.path,
            extension: format.extension,
            join: opts?.joinKinds?.[segment.index] ?? "paragraph",
          })),
          fadeMs,
          {
            download: downloadFileToPath,
            upload: async (localPath, contentType) => {
              const uploaded = await uploadFileFromPath(
                `audiobooks/${jobId}`,
                "full.mp3",
                localPath,
                contentType
              );
              return uploaded.path;
            },
            run: spawnFfmpeg,
          }
        );
        if (opts?.onDryUploaded) await opts.onDryUploaded(streamed.storagePath);
        console.log(
          `[Job ${jobId}] streamed full audiobook ${streamed.storagePath} mastered=${streamed.deliveryMastered}`
        );
        return streamed.storagePath;
      } catch (err) {
        console.error(
          `[Job ${jobId}] streamed finalize failed:`,
          err instanceof Error ? err.message : err
        );
        return null;
      }
    }
  }
  let built: {
    buffer: Buffer;
    format: AudioFormat;
    deliveryMastered?: boolean;
  } | null = null;
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

  const inlineMastered =
    Boolean(built.deliveryMastered) && masterDenoiseWet() <= 0 && !opts?.enhance;
  const mastered = await applyFullBookMastering(built.buffer, built.format, {
    alreadyMastered: opts?.alreadyMastered || inlineMastered,
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
