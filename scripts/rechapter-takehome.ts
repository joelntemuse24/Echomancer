/**
 * Re-chapter a finished Whole book without synthesizing again.
 *
 * Dry run from files (no database, character-fraction timestamps):
 *   npx tsx scripts/rechapter-takehome.ts --dry-run --text content.txt --pdf source.pdf --seconds 193662.171
 *
 * Dry run of a stored job (reads storage, prints MP3 timestamps, writes nothing):
 *   cd /opt/echomancer/app && sudo -u echomancer env WORKER_ENV_FILE=/opt/echomancer/app/.env.worker npx tsx scripts/rechapter-takehome.ts --dry-run 8eb1e065
 *
 * Production worker (backs up chapter files; rewrites full.mp3 only when a
 * local ID3 header has room for the new chapters):
 *   cd /opt/echomancer/app && sudo -u echomancer env WORKER_ENV_FILE=/opt/echomancer/app/.env.worker npx tsx scripts/rechapter-takehome.ts 8eb1e065
 *
 * AI chaptering (default when OPENROUTER_API_KEY is set; --no-ai forces the
 * heuristic outline). Re-runs detection on the finished book's frozen
 * speakable text and retimes playback-chapters.json without resynthesizing:
 *   npx tsx scripts/rechapter-takehome.ts --dry-run <jobId>
 *   npx tsx scripts/rechapter-takehome.ts --no-ai <jobId>
 * Override the model with CHAPTER_AI_MODEL.
 *
 * Optional spoken snap (off unless this flag is passed, and only when
 * faster-whisper or whisper is on PATH):
 *   npx tsx scripts/rechapter-takehome.ts --asr-snap --dry-run <jobId>
 *
 * Writes playback-chapters.json, section-starts.json, and the upload chapters.json.
 * Section times come from MP3 frames (or ffprobe on a local file), scaled so
 * they end on full.mp3. A stored section-starts.json is kept when its total
 * already matches that file.
 */
import "@/worker/load-env";

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { query, queryOne } from "@/lib/turso";
import { CHAPTERS_JSON_NAME, resolveChapters, type ChaptersDocument } from "@/lib/book-chapters";
import { resolveAiChapters } from "@/lib/tts/chapter-ai";
import {
  anchorChapterTree,
  playbackTreeFromCharStarts,
  timePlaybackTree,
  type PlaybackChapter,
} from "@/lib/player/playback-chapters";
import { extractDocument } from "@/lib/text-extraction";
import { downloadFile, uploadFile } from "@/lib/storage";
import { isR2Configured } from "@/lib/r2-storage";
import { applyAsrSnap, resolveAsrCommand, segmentsFromWhisperJson } from "@/lib/tts/asr-snap";
import { rewriteId3ChapterHeader } from "@/lib/tts/id3-inplace";
import { mp3DeclaredDurationSeconds, mp3DurationSeconds } from "@/lib/tts/mp3-duration";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { parseSegmentMap } from "@/lib/tts/section-index";
import {
  relocateSections,
  scaleSectionStarts,
  storedStartsMatchFile,
  type SectionClock,
} from "@/lib/tts/section-clock";
import { loadFrozenScript, PLAYBACK_CHAPTERS_NAME } from "@/lib/tts/frozen-script";
import type { FrozenSection } from "@/lib/tts/types";

const HEADER_BYTES = 2 * 1024 * 1024;
const XING_PREFIX_BYTES = 256 * 1024;

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

/**
 * AI chaptering first (worker host), heuristic outline on opt-out or failure.
 * No audio is regenerated; offsets are retimed from the stored sections.
 */
async function resolveChaptersForRechapter(
  text: string,
  tocLines?: string[]
): Promise<ChaptersDocument> {
  const hint = { source: "heading-lines" as const, titles: [], tocLines };
  if (!process.argv.includes("--no-ai")) {
    try {
      const ai = await resolveAiChapters(text, hint, { host: "worker" });
      if (ai && ai.chapters.length > 0) {
        console.log(`AI chapters: ${ai.chapters.length} top-level chapters (source=ai)`);
        return ai;
      }
      console.log("AI chaptering found nothing; using the heuristic outline.");
    } catch (err) {
      console.log(
        "AI chaptering failed; using the heuristic outline:",
        err instanceof Error ? err.message : err
      );
    }
  }
  return resolveChapters(text, hint);
}

async function readStoragePrefix(storagePath: string, bytes: number): Promise<Buffer | null> {
  try {
    if (isR2Configured()) {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getR2Client } = await import("@/lib/r2-storage");
      const response = await getR2Client().send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME || "echomancer-audio",
          Key: storagePath,
          Range: `bytes=0-${bytes - 1}`,
        })
      );
      const body = response.Body;
      if (!body || !("transformToByteArray" in body)) return null;
      return Buffer.from(await body.transformToByteArray());
    }
    const { getFullPath } = await import("@/lib/storage");
    const fh = await (await import("node:fs/promises")).open(getFullPath(storagePath), "r");
    const buf = Buffer.alloc(bytes);
    const read = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    return buf.subarray(0, read.bytesRead);
  } catch {
    return null;
  }
}

/** Frame duration. Local files use ffprobe when it answers; object storage never uses size. */
async function measuredSeconds(storagePath: string): Promise<number | null> {
  if (!storagePath) return null;
  try {
    if (!isR2Configured()) {
      const { getFullPath } = await import("@/lib/storage");
      const local = getFullPath(storagePath);
      const probed = await ffprobeSeconds(local);
      if (probed) return probed;
      return mp3DurationSeconds(await readFile(local));
    }
    const prefix = await readStoragePrefix(storagePath, XING_PREFIX_BYTES);
    const declared = prefix ? mp3DeclaredDurationSeconds(prefix) : null;
    if (declared) return declared;
    return mp3DurationSeconds(await downloadFile(storagePath));
  } catch (err) {
    console.error(
      `Could not measure ${storagePath}:`,
      err instanceof Error ? err.message : err
    );
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
  const doc = await resolveChaptersForRechapter(text, tocLines);
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
      ? "Timestamps are character-fraction estimates. A stored job uses measured section frames."
      : "No --seconds given. Clocks are fractions of 1 second."
  );
  printTree(timed);
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
  const doc = await resolveChaptersForRechapter(text, tocLines);
  const anchored = anchorChapterTree(doc.chapters, text);
  const chapters = anchored.length > 0 ? anchored : doc.chapters;
  const sections: FrozenSection[] = [...(frozen?.sections ?? [])].sort((a, b) => a.index - b.index);
  const segments = parseSegmentMap(job.segments_json);
  const fullPath = job.audio_storage_path || `audiobooks/${job.id}/full.mp3`;
  const clock = await sectionClock(job.id, fullPath, sections, segments);
  const { sectionStarts, totalSeconds } = clock;
  const tree = playbackTreeFromCharStarts(chapters, text.length);
  const timedStarts = sections.map((section) => sectionStarts[section.index] ?? 0);
  let timed =
    sections.length > 0 && totalSeconds > 0
      ? timePlaybackTree(
          tree,
          relocateSections(
            sections.map((section) => ({
              charStart: section.charStart,
              charEnd: section.charEnd,
              text: section.text,
            })),
            text
          ),
          timedStarts,
          totalSeconds
        )
      : tree;
  if (process.argv.includes("--asr-snap")) {
    timed = await snapSpokenHeadings(timed, fullPath, totalSeconds);
  }
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
    console.log(await rewriteFullMp3Chapters(fullPath, timed));
  } else {
    console.log("Dry run. Nothing was written.");
    console.log(id3SkipNote());
  }
  const topics = doc.chapters.reduce((sum, chapter) => sum + (chapter.children?.length ?? 0), 0);
  console.log(`${job.id} source=${doc.source} chapters=${doc.chapters.length} topics=${topics}`);
  printTree(timed);
}

async function sectionClock(
  jobId: string,
  fullPath: string,
  sections: FrozenSection[],
  segments: ReturnType<typeof parseSegmentMap>
): Promise<SectionClock> {
  const fullSeconds = await measuredSeconds(fullPath);
  const stored = await loadStoredClock(jobId);
  if (stored && fullSeconds && storedStartsMatchFile(stored, fullSeconds)) {
    console.log(
      `Using section-starts.json (${stored.totalSeconds.toFixed(1)}s matches full.mp3).`
    );
    return { sectionStarts: stored.sectionStarts, totalSeconds: fullSeconds };
  }
  if (stored && fullSeconds) {
    console.log(
      `section-starts.json is ${stored.totalSeconds.toFixed(1)}s and full.mp3 is ${fullSeconds.toFixed(1)}s. Measuring section frames.`
    );
  }
  const durations: number[] = [];
  for (const section of sections) {
    const segment = segments.find((item) => item.index === section.index);
    const measured = segment?.path ? await measuredSeconds(segment.path) : null;
    if (measured && measured > 0) {
      durations[section.index] = measured;
      continue;
    }
    if (segment?.durationSeconds && segment.durationSeconds > 0) {
      console.log(`Section ${section.index} has no MP3 frames. Using its stored duration.`);
      durations[section.index] = segment.durationSeconds;
      continue;
    }
    console.log(`Section ${section.index} has no measurable duration.`);
    durations[section.index] = 0;
  }
  const max = sections.reduce((peak, section) => Math.max(peak, section.index), -1);
  const dense = Array.from({ length: max + 1 }, (_, index) => durations[index] ?? 0);
  const sum = dense.reduce((total, value) => total + value, 0);
  const clock = scaleSectionStarts(dense, fullSeconds ?? 0);
  console.log(
    fullSeconds
      ? `Section frames sum to ${sum.toFixed(1)}s, scaled to full.mp3 ${fullSeconds.toFixed(1)}s.`
      : "full.mp3 duration was not measured. Section frames were not scaled."
  );
  return clock;
}

async function loadStoredClock(jobId: string): Promise<SectionClock | null> {
  try {
    const parsed = JSON.parse(
      (await downloadFile(`audiobooks/${jobId}/section-starts.json`)).toString("utf8")
    ) as { sectionStarts?: unknown; totalSeconds?: unknown };
    if (!Array.isArray(parsed.sectionStarts) || typeof parsed.totalSeconds !== "number") return null;
    const sectionStarts: number[] = [];
    for (let i = 0; i < parsed.sectionStarts.length; i++) {
      const start = parsed.sectionStarts[i];
      if (typeof start === "number" && Number.isFinite(start)) sectionStarts[i] = start;
    }
    return { sectionStarts, totalSeconds: parsed.totalSeconds };
  } catch {
    return null;
  }
}

function id3Rows(chapters: PlaybackChapter[]): { title: string; startMs: number; endMs: number }[] {
  const rows: { title: string; startMs: number; endMs: number }[] = [];
  const walk = (list: PlaybackChapter[]) => {
    for (const chapter of list) {
      if (typeof chapter.startSeconds === "number") {
        const title = chapter.subtitle ? `${chapter.title} — ${chapter.subtitle}` : chapter.title;
        const startMs = Math.round(chapter.startSeconds * 1000);
        const endMs = Math.round((chapter.endSeconds ?? chapter.startSeconds + 1) * 1000);
        rows.push({ title, startMs, endMs: Math.max(startMs + 1, endMs) });
      }
      if (chapter.children?.length) walk(chapter.children);
    }
  };
  walk(chapters);
  rows.sort((a, b) => a.startMs - b.startMs);
  return rows;
}

function id3SkipNote(): string {
  if (isR2Configured()) {
    return "full.mp3 is in object storage. Patching the ID3 header would re-upload the book, so the file was left as it is. The player reads playback-chapters.json.";
  }
  return "Dry run. full.mp3 was not rewritten.";
}

async function rewriteFullMp3Chapters(storagePath: string, chapters: PlaybackChapter[]): Promise<string> {
  if (isR2Configured()) return id3SkipNote();
  const rows = id3Rows(chapters);
  if (rows.length === 0) return "No chapter times to write into full.mp3.";
  const { getFullPath } = await import("@/lib/storage");
  const fh = await (await import("node:fs/promises")).open(getFullPath(storagePath), "r+");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const read = await fh.read(buf, 0, buf.length, 0);
    const rewritten = rewriteId3ChapterHeader(buf.subarray(0, read.bytesRead), rows);
    if (!rewritten.ok) return `full.mp3 ID3 was not rewritten: ${rewritten.reason}`;
    await fh.write(rewritten.bytes, 0, rewritten.bytes.length, 0);
    return "full.mp3 ID3 chapters were rewritten in the existing header.";
  } catch (err) {
    return `full.mp3 ID3 was not rewritten: ${err instanceof Error ? err.message : err}`;
  } finally {
    await fh.close();
  }
}

async function snapSpokenHeadings(
  chapters: PlaybackChapter[],
  storagePath: string,
  totalSeconds: number
): Promise<PlaybackChapter[]> {
  const bin = await resolveAsrCommand();
  if (!bin) {
    console.log("--asr-snap skipped: neither faster-whisper nor whisper is on PATH.");
    return chapters;
  }
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  let local = storagePath;
  if (isR2Configured()) {
    const os = await import("node:os");
    const path = await import("node:path");
    local = path.join(os.tmpdir(), `echomancer-asr-${path.basename(storagePath)}`);
    console.log(`Downloading ${storagePath} for --asr-snap.`);
    const { downloadFileToPath } = await import("@/lib/storage");
    await downloadFileToPath(storagePath, local);
  } else {
    const { getFullPath } = await import("@/lib/storage");
    local = getFullPath(storagePath);
  }
  const snapped = await applyAsrSnap(chapters, totalSeconds, async (start, end) => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "echomancer-asr-"));
    const wav = path.join(dir, "window.wav");
    const sliced = await runCommand(ffmpeg, [
      "-y",
      "-ss",
      String(start),
      "-to",
      String(end),
      "-i",
      local,
      "-ac",
      "1",
      "-ar",
      "16000",
      wav,
    ]);
    if (!sliced) {
      console.log(`--asr-snap could not slice ${start.toFixed(1)}s. The estimate was kept.`);
      return null;
    }
    const args =
      bin === "faster-whisper"
        ? [wav, "--language", "en", "--output_format", "json", "--output_dir", dir, "--word_timestamps", "True"]
        : [
            wav,
            "--model",
            "tiny",
            "--language",
            "en",
            "--output_format",
            "json",
            "--output_dir",
            dir,
            "--word_timestamps",
            "True",
          ];
    const ok = await runCommand(bin, args);
    if (!ok) {
      console.log(`--asr-snap ${bin} failed. The estimate was kept.`);
      return null;
    }
    try {
      const jsonPath = path.join(dir, "window.json");
      const payload = JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown;
      return segmentsFromWhisperJson(payload);
    } catch {
      console.log("--asr-snap found no transcript. The estimate was kept.");
      return null;
    }
  });
  return restampEnds(snapped, totalSeconds, totalSeconds);
}

function restampEnds(
  chapters: PlaybackChapter[],
  boundary: number,
  fileSeconds: number
): PlaybackChapter[] {
  return chapters.map((chapter, index) => {
    const next = chapters[index + 1]?.startSeconds ?? boundary;
    const start = chapter.startSeconds ?? 0;
    const children = chapter.children?.length
      ? restampEnds(chapter.children, next, fileSeconds)
      : undefined;
    return {
      ...chapter,
      endSeconds: Math.round(Math.max(start, next) * 1000) / 1000,
      startFraction:
        fileSeconds > 0
          ? Math.round(Math.min(1, Math.max(0, start / fileSeconds)) * 10000) / 10000
          : chapter.startFraction,
      ...(children && children.length > 0 ? { children } : {}),
    };
  });
}

function runCommand(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  if (dry && arg("--text")) {
    await dryRun();
    return;
  }
  const named = dry ? arg("--dry-run") : undefined;
  const positional = process.argv.slice(2).find((item) => item && !item.startsWith("-"));
  const prefix = (named && !named.startsWith("-") ? named : positional)?.trim();
  if (!prefix) {
    console.error(
      "Usage: npx tsx scripts/rechapter-takehome.ts [--asr-snap] <jobId> | --dry-run <jobId> | --dry-run --text <file> [--pdf <file>] [--seconds <n>]"
    );
    process.exit(1);
  }
  await rechapterJob(prefix, !dry);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
