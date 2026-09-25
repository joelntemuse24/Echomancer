/**
 * One listen-prep pass per uploaded book. The cleaned text and the chunk
 * notes are stored next to content.txt and reused by the narrator route
 * and by take-home freeze.
 */

import { createHash } from "node:crypto";
import { downloadFile, uploadFile } from "@/lib/storage";
import { takehomeWorkerSecret, takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import {
  narratorFromChunkNotes,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";
import {
  LISTEN_PREP_MAX_ATTEMPTS,
  prepareForListening,
  type ListenChunkRecord,
  type ListenNote,
  type ListenPrepFetch,
  type ListenPrepResult,
} from "@/lib/tts/listen-prep";

export const LISTEN_CLEANED_NAME = "listen-cleaned.txt";
export const LISTEN_PREP_NAME = "listen-prep.json";

const inflight = new Map<string, Promise<ListenPrepCache | null>>();

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
};

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
  rawText: string
): Promise<{ text: string; settled: boolean } | null> {
  const record = await readRecord(uploadId);
  if (!record || record.sourceHash !== sourceHash(rawText)) return null;
  if (record.status !== "done" && record.status !== "partial") return null;
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
  rawText: string
): Promise<ListenPrepCache | null> {
  const record = await readRecord(uploadId);
  if (record?.status !== "done" || record.sourceHash !== sourceHash(rawText)) return null;
  if (!record.narratorSettled) return null;
  try {
    const text = (await downloadFile(cleanedKey(uploadId))).toString("utf8");
    return {
      text,
      sourceHash: record.sourceHash,
      narrator: record.narrator ?? null,
      notes: Array.isArray(record.notes) ? record.notes : [],
    };
  } catch {
    return null;
  }
}

async function writeRunning(uploadId: string, hash: string): Promise<void> {
  const body: PrepRecord = { status: "running", sourceHash: hash, startedAt: Date.now() };
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
  attempts: number
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
  opts?: { fetch?: ListenPrepFetch; label?: string; waitMs?: number }
): Promise<ListenPrepCache | null> {
  const cached = await readListenPrepCache(uploadId, rawText);
  if (cached) return cached;
  const existing = inflight.get(uploadId);
  if (existing) return existing;
  const run = runListenPrep(uploadId, rawText, opts).finally(() => {
    inflight.delete(uploadId);
  });
  inflight.set(uploadId, run);
  return run;
}

async function runListenPrep(
  uploadId: string,
  rawText: string,
  opts?: { fetch?: ListenPrepFetch; label?: string; waitMs?: number }
): Promise<ListenPrepCache | null> {
  const hash = sourceHash(rawText);
  const record = await readRecord(uploadId);
  const prior =
    record?.sourceHash === hash && Array.isArray(record.chunks) ? record.chunks : undefined;
  const attempts = (record?.sourceHash === hash ? record.attempts || 0 : 0) + 1;
  const fresh =
    record?.status === "running" &&
    record.sourceHash === hash &&
    typeof record.startedAt === "number" &&
    Date.now() - record.startedAt < 120_000;
  if (fresh) {
    const found = await waitForCache(uploadId, rawText, opts?.waitMs ?? 8_000);
    if (found) return found;
  }
  try {
    await writeRunning(uploadId, hash);
  } catch {
    // Another writer may still finish. Fall through and clean once here.
  }
  const again = await readListenPrepCache(uploadId, rawText);
  if (again) return again;
  const prep = await prepareForListening(rawText, { fetch: opts?.fetch, prior });
  logListenPrep(opts?.label || `upload ${uploadId}`, prep);
  const narrator = narratorFromChunkNotes(prep.notes);
  if (prep.chunkCount === 0) {
    return { text: prep.text, sourceHash: hash, narrator: null, notes: [] };
  }
  try {
    await writePrep(uploadId, hash, prep, narrator, attempts);
  } catch (err) {
    console.warn(
      `[listen-prep] cache write failed for ${uploadId}:`,
      err instanceof Error ? err.message : err
    );
  }
  return { text: prep.text, sourceHash: hash, narrator, notes: prep.notes };
}

async function waitForCache(
  uploadId: string,
  rawText: string,
  waitMs: number
): Promise<ListenPrepCache | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const cached = await readListenPrepCache(uploadId, rawText);
    if (cached) return cached;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
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
  await ensureListenPrep(uploadId, raw, { label: `upload ${uploadId}` });
}

export async function prepareUploadForListening(uploadId: string): Promise<void> {
  const raw = (await downloadFile(`pdfs/${uploadId}/content.txt`)).toString("utf8");
  await ensureListenPrep(uploadId, raw, { label: `upload ${uploadId}`, waitMs: 20_000 });
}
