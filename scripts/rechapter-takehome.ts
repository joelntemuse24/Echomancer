/**
 * Re-chapter a finished Whole book without synthesizing again.
 *
 * Dry run from files (no database, character-fraction timestamps):
 *   npx tsx scripts/rechapter-takehome.ts --dry-run --text content.txt --pdf source.pdf --seconds 193662.171
 *
 * Dry run of a stored job (reads storage, prints MP3 timestamps, writes nothing):
 *   cd /opt/echomancer/app && sudo -u echomancer env WORKER_ENV_FILE=/opt/echomancer/app/.env.worker npx tsx scripts/rechapter-takehome.ts --dry-run 8eb1e065
 *
 * Production worker (backs up chapter files, does not rewrite full.mp3):
 *   cd /opt/echomancer/app && sudo -u echomancer env WORKER_ENV_FILE=/opt/echomancer/app/.env.worker npx tsx scripts/rechapter-takehome.ts 8eb1e065
 *
 * Writes playback-chapters.json, section-starts.json, and the upload chapters.json.
 */
import "@/worker/load-env";

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { query, queryOne } from "@/lib/turso";
import { CHAPTERS_JSON_NAME, resolveChapters, type ChaptersDocument } from "@/lib/book-chapters";
import {
  anchorChapterTree,
  playbackTreeFromCharStarts,
  timePlaybackTree,
  type PlaybackChapter,
} from "@/lib/player/playback-chapters";
import { extractDocument } from "@/lib/text-extraction";
import { downloadFile, getFileMetadata, uploadFile } from "@/lib/storage";
import { isR2Configured } from "@/lib/r2-storage";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { parseSegmentMap } from "@/lib/tts/section-index";
import { loadFrozenScript, PLAYBACK_CHAPTERS_NAME } from "@/lib/tts/frozen-script";
import type { FrozenSection } from "@/lib/tts/types";

const HEADER_BYTES = 2 * 1024 * 1024;
const CBR_BITS = 128_000;

type JobRow = {
  id: string;
  status: string;
  pdf_storage_path: string | null;
  segments_json: string | null;
  audio_storage_path: string | null;
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function cbrSeconds(size: number): number {
  return (size * 8) / CBR_BITS;
}

function ffprobeSeconds(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const bin = process.env.FFPROBE_PATH || "ffprobe";
    const child = spawn(
      bin,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const value = Number(out.trim());
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

async function tocLinesFromPdf(bytes: Uint8Array): Promise<string[] | undefined> {
  try {
    const extracted = await extractDocument(bytes, "source.pdf", "application/pdf");
    return extracted.hint.tocLines;
  } catch (err) {
    console.error(
      "PDF contents lines were not read:",
      err instanceof Error ? err.message : err
    );
    return undefined;
  }
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

function printTree(chapters: PlaybackChapter[], depth = 0): void {
  for (const chapter of chapters) {
    const pad = "  ".repeat(depth);
    const clock =
      typeof chapter.startSeconds === "number" ? formatClock(chapter.startSeconds) : "??:??:??";
    const subtitle = chapter.subtitle ? ` — ${chapter.subtitle}` : "";
    console.log(`${pad}${clock}  ${chapter.title}${subtitle}`);
    if (chapter.children?.length) printTree(chapter.children, depth + 1);
  }
}

async function headerHasChap(storagePath: string): Promise<boolean | null> {
  try {
    if (isR2Configured()) {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("@/lib/r2-storage");
      const response = await getR2Client().send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME || "echomancer-audio",
          Key: storagePath,
          Range: `bytes=0-${HEADER_BYTES - 1}`,
        })
      );
      const body = response.Body;
      if (!body || !("transformToByteArray" in body)) return null;
      const bytes = Buffer.from(await body.transformToByteArray());
      return bytes.includes(Buffer.from("CHAP"));
    }
    const { getFullPath } = await import("@/lib/storage");
    const fh = await (await import("node:fs/promises")).open(getFullPath(storagePath), "r");
    const buf = Buffer.alloc(HEADER_BYTES);
    const read = await fh.read(buf, 0, HEADER_BYTES, 0);
    await fh.close();
    return buf.subarray(0, read.bytesRead).includes(Buffer.from("CHAP"));
  } catch {
    return null;
  }
}

async function dryRun(): Promise<void> {
  const textPath = arg("--text");
  if (!textPath) {
    console.error("--dry-run needs --text <extracted.txt>");
    process.exit(1);
  }
  const text = await readFile(textPath, "utf8");
  const seconds = Number(arg("--seconds") ?? "0");
  let tocLines: string[] | undefined;
  const pdfPath = arg("--pdf");
  if (pdfPath) {
    const bytes = new Uint8Array(await readFile(pdfPath));
    tocLines = await tocLinesFromPdf(bytes);
    console.log(`Contents lines from PDF: ${tocLines?.length ?? 0}`);
  }
  const doc = resolveChapters(text, { source: "heading-lines", titles: [], tocLines });
  const anchored = anchorChapterTree(doc.chapters, text);
  const tree = playbackTreeFromCharStarts(
    anchored.length > 0 ? anchored : doc.chapters,
    text.length
  );
  const total = seconds > 0 ? seconds : 1;
  const timed = tree.map(function stamp(chapter): PlaybackChapter {
    const start = ((chapter.charStart ?? 0) / Math.max(1, text.length)) * total;
    return {
      ...chapter,
      startSeconds: Math.round(start * 1000) / 1000,
      startFraction: start / total,
      children: chapter.children?.map(stamp),
    };
  });
  const topics = doc.chapters.reduce((sum, chapter) => sum + (chapter.children?.length ?? 0), 0);
  console.log(`source=${doc.source} chapters=${doc.chapters.length} topics=${topics}`);
  console.log(
    seconds > 0
      ? "Timestamps are character-fraction estimates. Production uses section durations."
      : "No --seconds given. Clocks are fractions of 1 second."
  );
  printTree(timed);
}

async function sectionDuration(path: string, fallback?: number): Promise<number> {
  if (!isR2Configured() && path) {
    const { getFullPath } = await import("@/lib/storage");
    const probed = await ffprobeSeconds(getFullPath(path));
    if (probed) return probed;
  }
  const meta = await getFileMetadata(path);
  if (meta && meta.size > 0) return cbrSeconds(meta.size);
  return fallback && fallback > 0 ? fallback : 0;
}

async function backupStored(directory: string, filename: string): Promise<void> {
  const storagePath = `${directory}/${filename}`;
  try {
    const bytes = await downloadFile(storagePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const copy = `${filename}.${stamp}.bak`;
    await uploadFile(directory, copy, bytes, "application/json");
    console.log(`Backed up ${storagePath} to ${directory}/${copy}`);
  } catch {
    console.log(`No existing ${storagePath} to back up.`);
  }
}

async function rechapterJob(prefix: string, write: boolean): Promise<void> {
  await ensureTtsJobColumns();
  const matches = await query<JobRow>(
    `SELECT id, status, pdf_storage_path, segments_json, audio_storage_path
     FROM jobs
     WHERE deleted_at IS NULL AND (id = ? OR id LIKE ?)
     LIMIT 5`,
    [prefix, `${prefix}%`]
  );
  if (matches.length !== 1) {
    console.error(matches.length === 0 ? `No job matches ${prefix}` : `More than one job matches ${prefix}`);
    process.exit(1);
  }
  const job = matches[0]!;
  const frozen = await loadFrozenScript(job.id);
  const text = frozen?.speakable || (job.pdf_storage_path ? (await downloadFile(job.pdf_storage_path)).toString("utf8") : "");
  if (!text.trim()) {
    console.error(`${job.id} has no frozen script and no content.txt`);
    process.exit(1);
  }
  const uploadId = job.pdf_storage_path?.match(/^pdfs\/([^/]+)\//)?.[1];
  let tocLines: string[] | undefined;
  if (uploadId) {
    const upload = await queryOne<{ source_path: string | null }>(
      `SELECT source_path FROM uploads WHERE id = ?`,
      [uploadId]
    );
    if (upload?.source_path) {
      const bytes = new Uint8Array(await downloadFile(upload.source_path));
      tocLines = await tocLinesFromPdf(bytes);
    }
  }
  const doc = resolveChapters(text, { source: "heading-lines", titles: [], tocLines });
  const anchored = anchorChapterTree(doc.chapters, text);
  const chapters = anchored.length > 0 ? anchored : doc.chapters;
  const sections: FrozenSection[] = frozen?.sections ?? [];
  const segments = parseSegmentMap(job.segments_json);
  const durations: number[] = [];
  for (const section of [...sections].sort((a, b) => a.index - b.index)) {
    const segment = segments.find((item) => item.index === section.index);
    durations[section.index] = await sectionDuration(
      segment?.path ?? "",
      segment?.durationSeconds
    );
  }
  const sectionStarts: number[] = [];
  let cursor = 0;
  for (const section of [...sections].sort((a, b) => a.index - b.index)) {
    sectionStarts[section.index] = cursor;
    cursor += durations[section.index] ?? 0;
  }
  const totalSeconds = cursor;
  const tree = playbackTreeFromCharStarts(chapters, text.length);
  const timed =
    sections.length > 0 && totalSeconds > 0
      ? timePlaybackTree(
          tree,
          sections.map((section) => ({ charStart: section.charStart, charEnd: section.charEnd })),
          sectionStarts,
          totalSeconds
        )
      : tree;
  if (write) {
    await backupStored(`audiobooks/${job.id}`, PLAYBACK_CHAPTERS_NAME);
    await backupStored(`audiobooks/${job.id}`, "section-starts.json");
    await uploadFile(
      `audiobooks/${job.id}`,
      PLAYBACK_CHAPTERS_NAME,
      Buffer.from(JSON.stringify({ chapters: timed, sectionStarts, totalSeconds }), "utf8"),
      "application/json"
    );
    await uploadFile(
      `audiobooks/${job.id}`,
      "section-starts.json",
      Buffer.from(JSON.stringify({ sectionStarts, totalSeconds }), "utf8"),
      "application/json"
    );
    if (uploadId) {
      await backupStored(`pdfs/${uploadId}`, CHAPTERS_JSON_NAME);
      const stored: ChaptersDocument = {
        version: 1,
        source: doc.source,
        chapters: doc.chapters,
      };
      await uploadFile(
        `pdfs/${uploadId}`,
        CHAPTERS_JSON_NAME,
        Buffer.from(JSON.stringify(stored), "utf8"),
        "application/json"
      );
    }
  } else if (uploadId) {
    console.log("Dry run. Nothing was written.");
  } else {
    console.log("Dry run. Nothing was written.");
  }
  const fullPath = job.audio_storage_path || `audiobooks/${job.id}/full.mp3`;
  const chap = await headerHasChap(fullPath);
  const topics = doc.chapters.reduce((sum, chapter) => sum + (chapter.children?.length ?? 0), 0);
  console.log(`${job.id} source=${doc.source} chapters=${doc.chapters.length} topics=${topics}`);
  console.log(
    chap == null
      ? "Could not read the full.mp3 header. The file was not rewritten."
      : chap
        ? "full.mp3 header contains CHAP. The file was not rewritten."
        : "full.mp3 header has no CHAP in the first 2MB. The file was not rewritten."
  );
  printTree(timed);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  if (dry && arg("--text")) {
    await dryRun();
    return;
  }
  const prefix = (dry ? arg("--dry-run") : process.argv[2])?.trim();
  if (!prefix || prefix.startsWith("-")) {
    console.error(
      "Usage: npx tsx scripts/rechapter-takehome.ts <jobId> | --dry-run <jobId> | --dry-run --text <file> [--pdf <file>] [--seconds <n>]"
    );
    process.exit(1);
  }
  await rechapterJob(prefix, !dry);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
