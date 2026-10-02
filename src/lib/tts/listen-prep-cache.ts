/**
 * One listen-prep pass per uploaded book. The cleaned text and the chunk
 * notes are stored next to content.txt and reused by the narrator route
 * and by take-home freeze.
 */

import { createHash } from "node:crypto";
import { downloadFile, uploadFile } from "@/lib/storage";
import { chaptersObjectKey, parseChaptersDocument } from "@/lib/book-chapters";
import { takehomeWorkerSecret, takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import {
  coerceNarratorRecommendation,
  narratorFromChunkNotes,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";
import {
  LISTEN_PREP_MAX_ATTEMPTS,
  listenPrepChunkTimeoutMs,
  prepareForListening,
  type ListenChunkRecord,
  type ListenNote,
  type ListenPrepFetch,
  type ListenPrepResult,
} from "@/lib/tts/listen-prep";

export const LISTEN_CLEANED_NAME = "listen-cleaned.txt";
export const LISTEN_PREP_NAME = "listen-prep.json";

const inflight = new Map<string, Promise<ListenPrepCache | null>>();

/** The tick cannot finish a model pass. The job should be queued again. */
export class ListenPrepDeferredError extends Error {
  constructor() {
    super("listen-prep deferred until a later tick");
    this.name = "ListenPrepDeferredError";
  }
}

function modelPassFits(deadlineMs?: number): boolean {
  if (deadlineMs == null) return true;
  return deadlineMs - Date.now() >= listenPrepChunkTimeoutMs();
}

export type ListenPrepCache = {
  text: string;
  sourceHash: string;
  narrator: NarratorRecommendation | null;
  notes: ListenNote[];
};

type PrepRecord = {
  status?: string;
  sourceHash?: string;
  startedAt?: number;
  model?: string;
  notes?: ListenNote[];
  narrator?: NarratorRecommendation | null;
  narratorSettled?: boolean;
  attempts?: number;
  chunks?: ListenChunkRecord[];
  /** Hash of the text last written to listen-cleaned.txt. */
  cleanedHash?: string;
  /** True when the pass ran with chapter-heading protection. */
  protectedHeadings?: boolean;
};

/** Chapter-heading source lines from chapters.json, or [] when none are stored. */
async function readChapterProtectLines(uploadId: string): Promise<string[]> {
  try {
    const doc = parseChaptersDocument(
      (await downloadFile(chaptersObjectKey(uploadId))).toString("utf8")
    );
    if (!doc) return [];
    return doc.chapters.map((chapter) => chapter.match ?? chapter.title);
  } catch {
    return [];
  }
}

function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function prepKey(uploadId: string): string {
  return `pdfs/${uploadId}/${LISTEN_PREP_NAME}`;
}

function cleanedKey(uploadId: string): string {
  return `pdfs/${uploadId}/${LISTEN_CLEANED_NAME}`;
}

async function readRecord(uploadId: string): Promise<PrepRecord | null> {
  try {
    return JSON.parse((await downloadFile(prepKey(uploadId))).toString("utf8")) as PrepRecord;
  } catch {
    return null;
  }
}

export function logListenPrep(label: string, prep: ListenPrepResult): void {
  console.log(
    `[${label}] listen-prep model=${prep.model} fallbackChunks=${prep.fallbackChunks} chunks=${prep.chunkCount} wallMs=${prep.wallMs} p50Ms=${prep.p50Ms} maxMs=${prep.maxMs} dropped=${prep.droppedLines} failOpen=${prep.failOpenChunks} rejected=${prep.rejectedChunks} sample=${JSON.stringify(prep.sample)}`
  );
}

/** True when this upload has no settled listen-prep record yet. */
export async function listenPrepPending(uploadId: string): Promise<boolean> {
  const record = await readRecord(uploadId);
  return record?.status !== "done" || record.narratorSettled !== true;
}

/** Best cleaned text so far, including a pass that still has failed chunks. */
export async function readListenPrepBest(
  uploadId: string,
  rawText: string,
  opts?: { protect?: boolean }
): Promise<{ text: string; settled: boolean } | null> {
  const record = await readRecord(uploadId);
  if (!record || record.sourceHash !== sourceHash(rawText)) return null;
  if (opts?.protect && record.protectedHeadings !== true) return null;
  if (
    record.status !== "done" &&
    record.status !== "partial" &&
    record.status !== "running"
  ) {
    return null;
  }
  if (record.status === "running" && record.cleanedHash !== record.sourceHash) {
    return null;
  }
  try {
    const text = (await downloadFile(cleanedKey(uploadId))).toString("utf8");
    return { text, settled: record.status === "done" };
  } catch {
    return null;
  }
}

/** Cached clean for this exact source, or null when it still needs a pass. */
export async function readListenPrepCache(
  uploadId: string,
  rawText: string,
  opts?: { protect?: boolean }
): Promise<ListenPrepCache | null> {
  const record = await readRecord(uploadId);
  if (record?.status !== "done" || record.sourceHash !== sourceHash(rawText)) return null;
  if (opts?.protect && record.protectedHeadings !== true) return null;
  if (!record.narratorSettled) return null;
  try {
    const text = (await downloadFile(cleanedKey(uploadId))).toString("utf8");
    return {
      text,
      sourceHash: record.sourceHash,
      narrator: coerceNarratorRecommendation(record.narrator) ?? null,
      notes: Array.isArray(record.notes) ? record.notes : [],
    };
  } catch {
    return null;
  }
}

async function writeRunning(
  uploadId: string,
  hash: string,
  prior: PrepRecord | null,
  protect?: boolean
): Promise<void> {
  const same = prior?.sourceHash === hash;
  const body: PrepRecord = {
    status: "running",
    sourceHash: hash,
    startedAt: Date.now(),
    model: same ? prior?.model : undefined,
    notes: same ? prior?.notes : undefined,
    narrator: same ? prior?.narrator : undefined,
    attempts: same ? prior?.attempts : undefined,
    chunks: same ? prior?.chunks : undefined,
    cleanedHash: same ? prior?.cleanedHash : undefined,
    protectedHeadings: protect || (same ? prior?.protectedHeadings : undefined),
  };
  await uploadFile(
    `pdfs/${uploadId}`,
    LISTEN_PREP_NAME,
    Buffer.from(JSON.stringify(body), "utf8"),
    "application/json"
  );
}

async function writePrep(
  uploadId: string,
  hash: string,
  prep: ListenPrepResult,
  narrator: NarratorRecommendation | null,
  attempts: number,
  protectedHeadings?: boolean
): Promise<void> {
  const failed = prep.chunks.some((chunk) => !chunk.ok);
  const settled = !failed || attempts >= LISTEN_PREP_MAX_ATTEMPTS;
  await uploadFile(
    `pdfs/${uploadId}`,
    LISTEN_CLEANED_NAME,
    Buffer.from(prep.text, "utf8"),
    "text/plain; charset=utf-8"
  );
  const body: PrepRecord = {
    status: settled ? "done" : "partial",
    sourceHash: hash,
    model: prep.model,
    notes: prep.notes,
    narrator,
    narratorSettled: settled,
    attempts,
    chunks: prep.chunks,
    cleanedHash: hash,
    protectedHeadings,
  };
  await uploadFile(
    `pdfs/${uploadId}`,
    LISTEN_PREP_NAME,
    Buffer.from(JSON.stringify(body), "utf8"),
    "application/json"
  );
}

/**
 * Run cleanup at most once for this upload. A fresh running marker means
 * another caller already started it; this waits briefly, then reuses the
 * result. A settled miss (no notes) is cached so the narrator route does
 * not try again.
 */
export async function ensureListenPrep(
  uploadId: string,
  rawText: string,
  opts?: {
    fetch?: ListenPrepFetch;
    label?: string;
    waitMs?: number;
    deadlineMs?: number;
    /** Require a pass that protected chapter headings; re-runs an unprotected cache. */
    protect?: boolean;
  }
): Promise<ListenPrepCache | null> {
  const cached = await readListenPrepCache(uploadId, rawText, opts);
  if (cached) return cached;
  const key = opts?.protect ? `${uploadId}:protect` : uploadId;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = runListenPrep(uploadId, rawText, opts).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

async function runListenPrep(
  uploadId: string,
  rawText: string,
  opts?: {
    fetch?: ListenPrepFetch;
    label?: string;
    waitMs?: number;
    deadlineMs?: number;
    protect?: boolean;
  }
): Promise<ListenPrepCache | null> {
  const hash = sourceHash(rawText);
  const protect = opts?.protect === true;
  const budgetLeft = () =>
    opts?.deadlineMs == null ? null : Math.max(0, opts.deadlineMs - Date.now());
  const record = await readRecord(uploadId);
  const same = record?.sourceHash === hash;
  // An unprotected pass may have dropped headings; its chunks are not reused.
  const prior =
    same && Array.isArray(record?.chunks) && (!protect || record?.protectedHeadings === true)
      ? record.chunks
      : undefined;
  const attempts = (same ? record?.attempts || 0 : 0) + 1;
  const fresh =
    record?.status === "running" &&
    same &&
    typeof record.startedAt === "number" &&
    Date.now() - record.startedAt < 120_000;
  if (fresh) {
    const requested = opts?.waitMs ?? 8_000;
    const left = budgetLeft();
    const found = await waitForRunningPrep(
      uploadId,
      rawText,
      left == null ? requested : Math.min(requested, left),
      record,
      protect
    );
    if (found) return found;
    if (!modelPassFits(opts?.deadlineMs)) throw new ListenPrepDeferredError();
  }
  if (same && (record?.attempts || 0) >= LISTEN_PREP_MAX_ATTEMPTS) {
    const best = await readListenPrepBest(uploadId, rawText, { protect });
    if (best) {
      return {
        text: best.text,
        sourceHash: hash,
        narrator: coerceNarratorRecommendation(record?.narrator) ?? null,
        notes: Array.isArray(record?.notes) ? record.notes : [],
      };
    }
  }
  if (!modelPassFits(opts?.deadlineMs)) throw new ListenPrepDeferredError();
  try {
    await writeRunning(uploadId, hash, record, protect);
  } catch {
    // Another writer may still finish. Fall through and clean once here.
  }
  const again = await readListenPrepCache(uploadId, rawText, { protect });
  if (again) return again;
  const prep = await prepareForListening(rawText, {
    fetch: opts?.fetch,
    prior,
    protect: protect ? await readChapterProtectLines(uploadId) : undefined,
  });
  logListenPrep(opts?.label || `upload ${uploadId}`, prep);
  const narrator = narratorFromChunkNotes(prep.notes);
  if (prep.chunkCount === 0) {
    return { text: prep.text, sourceHash: hash, narrator: null, notes: [] };
  }
  try {
    await writePrep(uploadId, hash, prep, narrator, attempts, protect);
  } catch (err) {
    console.warn(
      `[listen-prep] cache write failed for ${uploadId}:`,
      err instanceof Error ? err.message : err
    );
  }
  return { text: prep.text, sourceHash: hash, narrator, notes: prep.notes };
}

async function waitForRunningPrep(
  uploadId: string,
  rawText: string,
  waitMs: number,
  record: PrepRecord | null,
  protect?: boolean
): Promise<ListenPrepCache | null> {
  const hash = sourceHash(rawText);
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    const cached = await readListenPrepCache(uploadId, rawText, { protect });
    if (cached) return cached;
    const best = await readListenPrepBest(uploadId, rawText, { protect });
    if (best) {
      return {
        text: best.text,
        sourceHash: hash,
        narrator: coerceNarratorRecommendation(record?.narrator) ?? null,
        notes: Array.isArray(record?.notes) ? record.notes : [],
      };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/** Skip when a fresh run or a settled record for this source is already stored. */
export async function scheduleListenPrepUnlessFresh(
  uploadId: string,
  rawText: string
): Promise<void> {
  const record = await readRecord(uploadId);
  const hash = sourceHash(rawText);
  if (record?.sourceHash !== hash) {
    scheduleListenPrep(uploadId);
    return;
  }
  if (record.status === "done" && record.narratorSettled) return;
  if (
    record.status === "partial" &&
    typeof record.attempts === "number" &&
    record.attempts >= LISTEN_PREP_MAX_ATTEMPTS
  ) {
    return;
  }
  if (
    record.status === "running" &&
    typeof record.startedAt === "number" &&
    Date.now() - record.startedAt < 120_000
  ) {
    return;
  }
  scheduleListenPrep(uploadId);
}

/** Fire-and-forget. The worker runs it when configured; otherwise this process does. */
export function scheduleListenPrep(uploadId: string): void {
  void kickListenPrep(uploadId).catch((err) => {
    console.warn(
      `[listen-prep] schedule failed for ${uploadId}:`,
      err instanceof Error ? err.message : err
    );
  });
}

async function kickListenPrep(uploadId: string): Promise<void> {
  const url = takehomeWorkerUrl();
  const secret = takehomeWorkerSecret();
  if (!url && !process.env.OPENROUTER_API_KEY?.trim()) return;
  if (url && secret) {
    const res = await fetch(`${url}/listen-prep`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadId }),
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok || res.status === 202) return;
  }
  const raw = (await downloadFile(`pdfs/${uploadId}/content.txt`)).toString("utf8");
  const protect = (await readChapterProtectLines(uploadId)).length > 0;
  await ensureListenPrep(uploadId, raw, { label: `upload ${uploadId}`, protect });
}

export async function prepareUploadForListening(uploadId: string): Promise<void> {
  const raw = (await downloadFile(`pdfs/${uploadId}/content.txt`)).toString("utf8");
  const protect = (await readChapterProtectLines(uploadId)).length > 0;
  await ensureListenPrep(uploadId, raw, {
    label: `upload ${uploadId}`,
    waitMs: 20_000,
    protect,
  });
}
