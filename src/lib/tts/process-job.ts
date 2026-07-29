/**
 * Offline take-home generation: section-by-section TTS → R2 → progress.
 */

import { downloadFile, uploadFile } from "@/lib/storage";
import { execute, query, queryOne } from "@/lib/turso";
import { updateJob, logUsage } from "@/lib/turso/jobs";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import { splitTextForTts } from "@/lib/tts/split-text";
import type { JobSegment } from "@/lib/tts/types";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { materializeFullAudiobook } from "@/lib/tts/concat-audio";

/**
 * Re-claim jobs stuck in processing after a Vercel 504 / crash.
 * Must be well under maxDuration (300s) so polls can resume quickly.
 */
const STALE_PROCESSING_SECONDS = Number(
  process.env.TTS_STALE_PROCESSING_SECONDS || "75"
);

export interface StockJobRow {
  id: string;
  status: string;
  pdf_storage_path: string;
  book_title: string;
  voice_name: string | null;
  tts_provider: string | null;
  provider_voice_id: string | null;
  catalog_voice_id: string | null;
  tts_options: string | null;
  segments_json: string | null;
  next_section_index: number | null;
  total_sections: number | null;
  char_count: number | null;
  job_kind: string | null;
  generation_mode: string | null;
}

async function loadBookText(pdfStoragePath: string): Promise<string> {
  const buf = await downloadFile(pdfStoragePath);
  return buf.toString("utf-8");
}

function parseSegments(json: string | null): JobSegment[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as JobSegment[];
  } catch {
    return [];
  }
}

export async function processTakehomeTick(
  jobId: string,
  opts?: { deadlineMs?: number; sectionsPerTick?: number }
): Promise<{
  done: boolean;
  nextIndex: number;
  total: number;
  busy?: boolean;
}> {
  await ensureTtsJobColumns();

  const job = await queryOne<StockJobRow>(
    `SELECT id, status, pdf_storage_path, book_title, voice_name,
            tts_provider, provider_voice_id, catalog_voice_id, tts_options,
            segments_json, next_section_index, total_sections, char_count,
            job_kind, generation_mode
     FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );

  if (!job) throw new Error("Job not found");
  if (job.status === "ready" || job.status === "failed") {
    return {
      done: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }

  // ── Atomic claim: only one tick can transition queued→processing ─────
  // Also re-claim stale 'processing' jobs (crashed/timed-out ticks).
  // SQLite serializes writes, so concurrent ticks racing will only see
  // rowsAffected=1 for the first one.
  const claim = await execute(
    `UPDATE jobs SET status = 'processing', processing_started_at = unixepoch(),
     generation_started_at = COALESCE(generation_started_at, unixepoch()),
     updated_at = unixepoch()
     WHERE id = ? AND (
       status = 'queued'
       OR (status = 'processing' AND processing_started_at IS NOT NULL
           AND unixepoch() - processing_started_at > ?)
       OR (status = 'processing' AND processing_started_at IS NULL
           AND updated_at IS NOT NULL
           AND unixepoch() - updated_at > ?)
     )`,
    [jobId, STALE_PROCESSING_SECONDS, STALE_PROCESSING_SECONDS]
  );
  if (!claim || claim.rowsAffected === 0) {
    // Another tick is already running — not finished
    return {
      done: false,
      busy: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }

  const providerId = job.tts_provider || "";
  if (!isStockProvider(providerId)) {
    await updateJob(jobId, { status: "failed", error_message: `Invalid stock provider: ${providerId}` });
    return { done: true, nextIndex: job.next_section_index ?? 0, total: job.total_sections ?? 0 };
  }

  let catalog: Awaited<ReturnType<typeof getCatalogVoice>>;
  try {
    catalog = job.catalog_voice_id
      ? await getCatalogVoice(job.catalog_voice_id, { hdEnabled: true })
      : undefined;
  } catch {
    catalog = undefined;
  }
  const voiceId = job.provider_voice_id || catalog?.providerVoiceId;
  if (!voiceId) {
    await updateJob(jobId, { status: "failed", error_message: "Missing provider_voice_id" });
    return { done: true, nextIndex: job.next_section_index ?? 0, total: job.total_sections ?? 0 };
  }

  let ttsOptions: { model?: string; stylePrompt?: string } = {};
  if (job.tts_options) {
    try {
      ttsOptions = JSON.parse(job.tts_options) as {
        model?: string;
        stylePrompt?: string;
      };
    } catch {
      /* ignore */
    }
  }
  const modelSlug = ttsOptions.model || catalog?.model;

  const maxChars =
    catalog?.maxCharsPerRequest ||
    (modelSlug?.includes("openai")
      ? 4000
      : modelSlug?.includes("gemini")
        ? 3000
        : modelSlug?.includes("zonos")
          ? 350
          : modelSlug?.includes("kokoro")
            ? 800
            : providerId === "grok"
              ? 8000
              : providerId === "gemini"
                ? 2800
                : 2000);

  // ── Only split text if we don't already know the section count ──────
  let total = job.total_sections ?? 0;
  let text: string | null = null;

  if (!total) {
    text = await loadBookText(job.pdf_storage_path);
    const sections = splitTextForTts(text, maxChars);
    total = sections.length;
  }

  if (total === 0) {
    await updateJob(jobId, {
      status: "failed",
      error_message: "No text to synthesize",
    });
    return { done: true, nextIndex: 0, total: 0 };
  }

  let nextIndex = job.next_section_index ?? 0;
  let segments = parseSegments(job.segments_json);

  if (!job.total_sections) {
    await execute(
      `UPDATE jobs SET total_sections = ?, char_count = ?, status = 'processing',
       updated_at = unixepoch() WHERE id = ?`,
      [total, text!.length, jobId]
    );
  }

  const provider = resolveStockAdapter({
    provider: providerId,
    model: modelSlug,
  });
  // Short poll budgets synthesize 1 section so GET /api/jobs/[id] cannot 504.
  const sectionsPerTick =
    opts?.sectionsPerTick ?? Number(process.env.TTS_SECTIONS_PER_TICK || "6");
  const end = Math.min(nextIndex + sectionsPerTick, total);
  const stopAt = opts?.deadlineMs ? opts.deadlineMs - 8_000 : undefined;

  // ── Lazy-load text only if we need to synthesize ────────────────────
  if (!text) {
    text = await loadBookText(job.pdf_storage_path);
  }
  const sections = splitTextForTts(text, maxChars);

  try {
  for (let i = nextIndex; i < end; i++) {
    if (stopAt && Date.now() >= stopAt) {
      console.log(
        `[Job ${jobId}] tick budget reached before section ${i} — parking queued`
      );
      break;
    }

    const existing = segments.find((s) => s.index === i && s.status === "ready");
    if (existing) {
      // C2 fix: advance nextIndex for already-ready sections to avoid infinite loop
      nextIndex = i + 1;
      continue;
    }

    const sectionText = sections[i]!;

    // ── Per-section retry with backoff ────────────────────────────────
    let lastErr: Error | null = null;
    let succeeded = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }

        // M6: Skip retry on non-retryable errors from previous attempt
        if (lastErr && /40[0134]|invalid|bad request/i.test(lastErr.message)) {
          break;
        }

        const { resolveStylePrompt } = await import("@/lib/tts/resolve-style-prompt");
        const {
          geminiDirectedInput,
          modelSupportsAccentVariants,
        } = await import("@/lib/tts/accent-prompt");
        const accent =
          catalog?.accentHint ||
          (catalog as { accent?: string } | undefined)?.accent ||
          undefined;
        const isGemini = modelSupportsAccentVariants(modelSlug || catalog?.model || "");
        const spoken = isGemini
          ? geminiDirectedInput(sectionText, accent)
          : sectionText;
        const result = await provider.synthesize({
          text: spoken,
          voiceId,
          language: catalog?.locale,
          model: modelSlug,
          stylePrompt: isGemini
            ? undefined
            : resolveStylePrompt({
                catalogStylePrompt: catalog?.stylePrompt,
                ttsOptionsStylePrompt: ttsOptions.stylePrompt,
                locale: catalog?.locale,
              }),
        });

        const ext = result.contentType.includes("wav")
          ? "wav"
          : result.contentType.includes("ogg")
            ? "ogg"
            : result.contentType.includes("pcm")
              ? "pcm"
              : "mp3";
        const filename = `sections/${String(i).padStart(4, "0")}.${ext}`;
        const uploaded = await uploadFile(
          `audiobooks/${jobId}`,
          filename,
          result.audio,
          result.contentType
        );

        const segment: JobSegment = {
          index: i,
          path: uploaded.path,
          status: "ready",
          contentType: result.contentType,
          durationSeconds: result.durationHintSeconds,
        };
        segments = [...segments.filter((s) => s.index !== i), segment].sort(
          (a, b) => a.index - b.index
        );

        nextIndex = i + 1;
        const progress = Math.min(99, Math.round((nextIndex / total) * 100));

        await execute(
          `UPDATE jobs SET next_section_index = ?, segments_json = ?, progress = ?,
           current_section = ?, total_sections = ?, status = 'processing',
           updated_at = unixepoch() WHERE id = ?`,
          [
            nextIndex,
            JSON.stringify(segments),
            progress,
            nextIndex,
            total,
            jobId,
          ]
        );

        succeeded = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        console.error(`[Job ${jobId}] section ${i} attempt ${attempt + 1} failed:`, lastErr.message);
      }
    }

    if (!succeeded) {
      const message = lastErr?.message || "TTS failed after 3 attempts";
      console.error(`[Job ${jobId}] section ${i} permanently failed:`, message);
      await updateJob(jobId, {
        status: "failed",
        error_message: `Section ${i}: ${message}`,
      });
      return { done: true, nextIndex: i, total };
    }
  }

  if (nextIndex >= total) {
    // Build one full-book file so download isn't a fragile multi-section stream
    let audioPath: string | null = null;
    try {
      audioPath = await materializeFullAudiobook(jobId, segments);
    } catch (err) {
      console.error(`[Job ${jobId}] failed to materialize full audiobook:`, err);
    }
    if (!audioPath) {
      const first = segments.find((s) => s.index === 0 && s.status === "ready");
      audioPath = first?.path || segments[0]?.path || null;
    }

    await execute(
      `UPDATE jobs SET status = 'ready', progress = 100, next_section_index = ?,
       segments_json = ?, audio_storage_path = ?,
       current_section = ?, total_sections = ?, updated_at = unixepoch()
       WHERE id = ?`,
      [total, JSON.stringify(segments), audioPath, total, total, jobId]
    );

    await logUsage({
      action: "takehome_complete",
      charsProcessed: text.length,
    });

    return { done: true, nextIndex: total, total };
  }

  // Set back to queued so the next tick can claim it
  const progress = Math.min(99, Math.round((nextIndex / total) * 100));
  await execute(
    `UPDATE jobs SET status = 'queued', processing_started_at = NULL,
     next_section_index = ?, progress = ?, current_section = ?,
     updated_at = unixepoch() WHERE id = ?`,
    [nextIndex, progress, nextIndex, jobId]
  );

  return { done: false, nextIndex, total };
  } catch (err) {
    // H1: Reset to queued so a future tick can re-claim — don't leave stuck in processing
    console.error(`[Job ${jobId}] tick failed, resetting to queued:`, err);
    await execute(
      `UPDATE jobs SET status = 'queued', processing_started_at = NULL,
       updated_at = unixepoch() WHERE id = ? AND status = 'processing'`,
      [jobId]
    ).catch(() => {});
    throw err;
  }
}

/**
 * Run take-home ticks inside the current invocation until done or budget.
 *
 * Do NOT rely on Next.js `after()` for this work — production logs showed
 * `after(() => …)` from GET/POST never executing (nudge spam, zero /process).
 * Callers must **await** this (or a short tick) in-request.
 *
 * Do NOT HTTP self-call `/api/jobs/[id]/process` from inside /process (Vercel 508).
 */
export async function runTakehomeWave(
  jobId: string,
  budgetMs = 240_000
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const maxTicks = Number(process.env.TTS_MAX_TICKS_PER_WAVE || "40");
  // Poll/nudge budgets must stay tiny — one section per tick.
  const sectionsPerTick = budgetMs <= 60_000 ? 1 : undefined;
  let ticks = 0;

  console.log(
    `[Job ${jobId}] take-home wave starting (budget=${budgetMs}ms)`
  );

  while (ticks < maxTicks && Date.now() < deadline) {
    ticks += 1;
    try {
      const result = await processTakehomeTick(jobId, {
        deadlineMs: deadline,
        sectionsPerTick,
      });
      if (result.busy) {
        console.log(`[Job ${jobId}] take-home tick busy — another worker holds claim`);
        return;
      }
      if (result.done) {
        console.log(
          `[Job ${jobId}] take-home finished after ${ticks} in-process tick(s)`
        );
        return;
      }
      console.log(
        `[Job ${jobId}] take-home tick ${ticks}: next=${result.nextIndex}/${result.total}`
      );
    } catch (err) {
      console.error(`[Job ${jobId}] in-process tick ${ticks} failed:`, err);
      return;
    }
  }

  console.warn(
    `[Job ${jobId}] take-home wave paused after ${ticks} tick(s) with work remaining — awaiting nudge`
  );
}

/** Poll-path budget: GET polls must stay well under Vercel maxDuration. */
const NUDGE_WAVE_BUDGET_MS = Number(
  process.env.TTS_NUDGE_WAVE_BUDGET_MS || "25000"
);

/** Create/retry path: more work before returning the job id. */
const START_WAVE_BUDGET_MS = Number(
  process.env.TTS_START_WAVE_BUDGET_MS || "240000"
);

/**
 * Start or continue take-home generation in the current request.
 * Replaces after()/HTTP-kick — both failed silently on Vercel production.
 */
export async function continueTakehome(
  jobId: string,
  budgetMs = START_WAVE_BUDGET_MS
): Promise<void> {
  await runTakehomeWave(jobId, budgetMs);
}

/**
 * @deprecated Prefer {@link continueTakehome}. Kept for manual/cron HTTP kicks.
 */
export async function kickTakehomeProcess(jobId: string): Promise<void> {
  const base = appBaseUrl();
  const secret = process.env.INTERNAL_JOB_SECRET || "";

  console.log(`[Job ${jobId}] kicking /process via HTTP`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
      const res = await fetch(`${base}/api/jobs/${jobId}/process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": secret,
        },
        body: JSON.stringify({}),
      });
      console.log(`[Job ${jobId}] /process kick status ${res.status}`);
      if (res.ok || res.status === 401) return;
    } catch (err) {
      console.error(
        `[Job ${jobId}] /process kick attempt ${attempt + 1} failed:`,
        err
      );
    }
  }
  console.error(`[Job ${jobId}] /process kick exhausted retries — job may stall`);
}

function appBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  return raw.replace(/\/$/, "");
}

/** @deprecated Use {@link continueTakehome} — after() does not run reliably here. */
export function chainTakehomeContinue(jobId: string): void {
  void continueTakehome(jobId);
}

/**
 * Re-queue jobs left in `processing` after a Vercel 504 killed the isolate.
 */
export async function recoverZombieTakehomeJobs(): Promise<number> {
  try {
    const result = await execute(
      `UPDATE jobs SET status = 'queued', processing_started_at = NULL,
       updated_at = unixepoch()
       WHERE deleted_at IS NULL
         AND job_kind = 'takehome'
         AND status = 'processing'
         AND (
           (processing_started_at IS NOT NULL
             AND unixepoch() - processing_started_at > ?)
           OR (processing_started_at IS NULL
             AND updated_at IS NOT NULL
             AND unixepoch() - updated_at > ?)
         )`,
      [STALE_PROCESSING_SECONDS, STALE_PROCESSING_SECONDS]
    );
    const n = result?.rowsAffected ?? 0;
    if (n > 0) {
      console.log(`[recoverZombieTakehomeJobs] re-queued ${n} stuck processing job(s)`);
    }
    return n;
  } catch (err) {
    console.error("[recoverZombieTakehomeJobs] failed:", err);
    return 0;
  }
}

/**
 * Re-kick take-home jobs stuck in `queued`.
 * Must be **awaited** by the HTTP handler — void/after drop the work on Vercel.
 */
export async function nudgeStaleTakehomeJobs(limit = 3): Promise<number> {
  const staleSeconds = Number(process.env.TTS_STALE_QUEUED_SECONDS || "10");
  try {
    await recoverZombieTakehomeJobs();
    const rows = await query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE deleted_at IS NULL
         AND job_kind = 'takehome'
         AND status = 'queued'
         AND updated_at IS NOT NULL
         AND unixepoch() - updated_at >= ?
       ORDER BY updated_at ASC
       LIMIT ?`,
      [staleSeconds, limit]
    );
    for (const row of rows) {
      console.log(`[Job ${row.id}] nudging stale queued take-home (inline wave)`);
      // Await in-request — do not after()/void. Claim lock drops concurrent losers.
      await continueTakehome(row.id, NUDGE_WAVE_BUDGET_MS);
    }
    return rows.length;
  } catch (err) {
    console.error("[nudgeStaleTakehomeJobs] failed:", err);
    return 0;
  }
}

/** Nudge a single job if it is a stale queued take-home (player poll path). */
export async function nudgeStaleTakehomeJobIfNeeded(
  job: {
    id: string;
    job_kind?: string | null;
    status: string;
    updated_at: number;
  }
): Promise<void> {
  const staleSeconds = Number(process.env.TTS_STALE_QUEUED_SECONDS || "10");
  if (job.job_kind !== "takehome") return;
  try {
    // Recover zombies stuck in processing after 504, then nudge if queued+stale
    if (job.status === "processing") {
      const n = await recoverZombieTakehomeJobs();
      if (n === 0) return; // still actively processing
      console.log(`[Job ${job.id}] recovered zombie processing — starting short wave`);
      await continueTakehome(job.id, NUDGE_WAVE_BUDGET_MS);
      return;
    }
    if (job.status !== "queued") return;
    if (Date.now() / 1000 - job.updated_at < staleSeconds) return;
    console.log(`[Job ${job.id}] nudging stale queued take-home (inline wave)`);
    await continueTakehome(job.id, NUDGE_WAVE_BUDGET_MS);
  } catch (err) {
    console.error(`[Job ${job.id}] single-job nudge failed:`, err);
  }
}

