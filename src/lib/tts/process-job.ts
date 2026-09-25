/**
 * Take-home generation: split the book, synthesize section by section, store
 * each one on R2, then assemble a single downloadable file.
 *
 * ## Why this is shaped like a queue instead of a loop
 *
 * A novel cannot be synthesized inside one serverless invocation, so a job is
 * advanced in **ticks** (K sections) grouped into **waves** (as many ticks as
 * one invocation's time budget allows). Progress lives in the `jobs` row
 * (`next_section_index`, `segments_json`), so any later invocation can pick the
 * job up exactly where the last one stopped.
 *
 * ## Who runs the work
 *
 * Primary host: always-on VM worker (`src/worker/takehome-server.ts`).
 * The process imports this module in-process — it never HTTP `/process`.
 * Trigger.dev (`takehome.advance` + `takehome.drain`) remains an optional
 * fallback when `WORKER_URL` is unset or `TAKEHOME_TRIGGER_FALLBACK=1`.
 * Vercel `POST /api/jobs/[id]/process` and `GET /api/cron/process-jobs` remain
 * as operator fallbacks. Production sets `TTS_POLL_NUDGE_BUDGET_MS=0` so
 * Library/Player polls never synthesize.
 *
 * ## Leases, not timeouts
 *
 * Two workers must never synthesize the same section: that bills the account
 * twice and races on `segments_json`. A worker claims a job by writing a random
 * `processing_lease_token` with an expiry, then **heartbeats** while it works.
 * Every progress write is conditioned on still holding that token, so a worker
 * whose lease was reclaimed (because it hung) cannot clobber its successor.
 * A purely time-based "stale after 75s" rule could not tell a hung worker from
 * a slow one, and double-synthesized any section that took longer than that.
 */

import { downloadFile, uploadFile } from "@/lib/storage";
import { execute, query, queryOne } from "@/lib/turso";
import { updateJob, logUsage } from "@/lib/turso/jobs";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import {
  loadFrozenScript,
  buildAndPersistFrozenScript,
} from "@/lib/tts/frozen-script";
import { ListenPrepDeferredError } from "@/lib/tts/listen-prep-cache";
import {
  narrationScriptForSynthesis,
  usesNarrationPauseScript,
} from "@/lib/tts/narration-script";
import {
  deliveryUserInputFromUnknown,
  resolveDeliverySettings,
  type ResolvedDeliverySettings,
} from "@/lib/tts/delivery-settings";
import {
  DEFAULT_NARRATION_SPEED,
  calibrateNarrationSpeed,
  fishSpeedForRequest,
  initialNarrationSpeed,
  wordCount,
} from "@/lib/tts/narration-pace";
import type { FrozenSection, JobSegment } from "@/lib/tts/types";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { materializeFullAudiobook } from "@/lib/tts/concat-audio";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import {
  catalogMaxForStoredProvider,
  hardMaxCharsForModel,
  maxCharsForModel,
} from "@/lib/tts/section-size";
import {
  allIndexesReady,
  claimIndexSet,
  claimableIndexes,
  createAsyncMutex,
  lowestUnclaimedAfter,
  lowestUnreadyIndex,
  mostIndexesReady,
  parseSegmentMap,
  readyCount,
  runIndexBoundFanout,
  sectionObjectName,
  upsertSegment,
} from "@/lib/tts/section-index";
import {
  readSectionCache,
  sectionCacheKey,
  writeSectionCache,
} from "@/lib/tts/section-cache";
import { takehomeFanoutCap, withFishSlot } from "@/lib/tts/fish-slots";
import { FishRateLimitError } from "@/lib/tts/providers/fish";

/** How long a claim survives without a heartbeat. */
export const LEASE_TTL_SECONDS = Number(
  process.env.TTS_LEASE_TTL_SECONDS || "90"
);

/**
 * Production default: Library/Player polls are read-only. The VM worker
 * (or Trigger fallback) runs Whole book. Set a positive value only for
 * local-without-a-worker.
 */
export const DEFAULT_POLL_NUDGE_BUDGET_MS = 0;

/** Trigger Cloud wave budget — minutes, not the 45s Hobby poll nudge. */
export const DEFAULT_TRIGGER_WAVE_BUDGET_MS = 900_000;

/** Hard ceiling so a mis-set env cannot blow past route maxDuration. */
export const MAX_POLL_NUDGE_BUDGET_MS = 45_000;

/**
 * Reserve time to park progress before the function is killed.
 * Must stay well below short poll-nudge budgets — the previous flat 8s reserve
 * made an 8s nudge park before section 0 ever started.
 */
export function tickWriteHeadroomMs(remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  if (remainingMs <= 12_000) {
    return Math.min(800, Math.floor(remainingMs * 0.1));
  }
  if (remainingMs <= 60_000) return 2_000;
  return 8_000;
}

function pollNudgeBudgetMs(): number {
  const raw = process.env.TTS_POLL_NUDGE_BUDGET_MS;
  if (raw === undefined || raw === "") return DEFAULT_POLL_NUDGE_BUDGET_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_POLL_NUDGE_BUDGET_MS;
  if (n <= 0) return 0;
  return Math.min(n, MAX_POLL_NUDGE_BUDGET_MS);
}

/** Heartbeat interval — comfortably inside the TTL so one slow write is fine. */
const LEASE_HEARTBEAT_MS = Math.max(
  5_000,
  Math.floor((LEASE_TTL_SECONDS * 1000) / 3)
);

const SECTION_ATTEMPTS = 3;

/** Fish `latency=normal` — most stable output for sections 1+. Live keeps `balanced`. */
export const TAKEHOME_FISH_LATENCY = "normal" as const;

/** Section 0 only — lower time-to-first-audio so the player can start sooner. */
export const TAKEHOME_FIRST_SECTION_FISH_LATENCY = "balanced" as const;

/** Official Fish default / max. Larger chunks phrase more of the script. */
export const TAKEHOME_FISH_CHUNK_LENGTH = 300;

/** Backoff between section retries; tests set it to 0. */
const RETRY_BACKOFF_MS = Number(process.env.TTS_RETRY_BACKOFF_MS ?? "1000");

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease lost for job ${jobId}`);
    this.name = "LeaseLostError";
  }
}

export interface StockJobRow {
  id: string;
  user_id: string;
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

function newLeaseToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function loadBookRaw(pdfStoragePath: string): Promise<string> {
  const buf = await downloadFile(pdfStoragePath);
  return buf.toString("utf-8");
}

function parseSegments(json: string | null): JobSegment[] {
  return parseSegmentMap(json);
}

/**
 * Take the lease for a job. Succeeds only when the job is waiting or when the
 * previous holder's lease has expired without a heartbeat.
 */
export async function claimTakehomeLease(
  jobId: string,
  ttlSeconds = LEASE_TTL_SECONDS
): Promise<string | null> {
  const token = newLeaseToken();
  const result = await execute(
    `UPDATE jobs SET status = 'processing',
       processing_lease_token = ?,
       lease_expires_at = unixepoch() + ?,
       processing_started_at = unixepoch(),
       generation_started_at = COALESCE(generation_started_at, unixepoch()),
       updated_at = unixepoch()
     WHERE id = ? AND deleted_at IS NULL
       AND status IN ('queued', 'processing')
       AND (processing_lease_token IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at <= unixepoch())`,
    [token, ttlSeconds, jobId]
  );
  return result.rowsAffected > 0 ? token : null;
}

async function heartbeatLease(
  jobId: string,
  token: string,
  ttlSeconds = LEASE_TTL_SECONDS
): Promise<boolean> {
  const result = await execute(
    `UPDATE jobs SET lease_expires_at = unixepoch() + ?, updated_at = unixepoch()
     WHERE id = ? AND processing_lease_token = ?`,
    [ttlSeconds, jobId, token]
  );
  return result.rowsAffected > 0;
}

/** Hand the job back so the next worker can claim it immediately. */
async function releaseLease(
  jobId: string,
  token: string,
  patch: { status: "queued" | "failed"; errorMessage?: string | null }
): Promise<void> {
  await execute(
    `UPDATE jobs SET status = ?, error_message = COALESCE(?, error_message),
       processing_lease_token = NULL, lease_expires_at = NULL,
       processing_started_at = NULL, updated_at = unixepoch()
     WHERE id = ? AND processing_lease_token = ?`,
    [patch.status, patch.errorMessage ?? null, jobId, token]
  );
}

/**
 * Keep the lease alive while a section is in flight. Without this, any section
 * slower than the TTL would be handed to a second worker mid-synthesis.
 */
function startLeaseHeartbeat(jobId: string, token: string) {
  let lost = false;
  const timer = setInterval(() => {
    void heartbeatLease(jobId, token)
      .then((held) => {
        if (!held) lost = true;
      })
      .catch(() => {
        /* transient DB error — the next beat retries */
      });
  }, LEASE_HEARTBEAT_MS);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => clearInterval(timer),
    get lost() {
      return lost;
    },
  };
}

/** A write that only lands while we still hold the lease. */
async function writeWithLease(
  jobId: string,
  token: string,
  sql: string,
  args: (string | number | null)[]
): Promise<void> {
  const result = await execute(sql, [...args, jobId, token]);
  if (result.rowsAffected === 0) throw new LeaseLostError(jobId);
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
    `SELECT id, user_id, status, pdf_storage_path, book_title, voice_name,
            tts_provider, provider_voice_id, catalog_voice_id, tts_options,
            segments_json, next_section_index, total_sections, char_count,
            job_kind, generation_mode
     FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );

  if (!job) throw new Error("Job not found");
  if (
    job.status === "ready" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    return {
      done: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }

  const lease = await claimTakehomeLease(jobId);
  if (!lease) {
    return {
      done: false,
      busy: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }

  const heartbeat = startLeaseHeartbeat(jobId, lease);
  try {
    return await runClaimedTick(job, lease, opts);
  } catch (err) {
    if (err instanceof ListenPrepDeferredError) {
      console.log(`[Job ${jobId}] listen-prep needs a later tick`);
      await releaseLease(jobId, lease, { status: "queued" }).catch(() => {});
      return {
        done: false,
        nextIndex: job.next_section_index ?? 0,
        total: job.total_sections ?? 0,
      };
    }
    if (err instanceof LeaseLostError) {
      console.warn(
        `[Job ${jobId}] lease reclaimed by another worker — abandoning tick`
      );
      return {
        done: false,
        busy: true,
        nextIndex: job.next_section_index ?? 0,
        total: job.total_sections ?? 0,
      };
    }
    // Hand the job back as `queued` so a later wave retries it.
    console.error(`[Job ${jobId}] tick failed, returning to queue:`, err);
    await releaseLease(jobId, lease, { status: "queued" }).catch(() => {});
    throw err;
  } finally {
    heartbeat.stop();
  }
}

async function runClaimedTick(
  job: StockJobRow,
  lease: string,
  opts?: { deadlineMs?: number; sectionsPerTick?: number }
): Promise<{ done: boolean; nextIndex: number; total: number }> {
  const jobId = job.id;
  const providerId = job.tts_provider || "";

  if (!isStockProvider(providerId)) {
    await failJob(jobId, lease, `Invalid stock provider: ${providerId}`);
    return {
      done: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }

  let catalog: Awaited<ReturnType<typeof getCatalogVoice>>;
  let existingFrozen: Awaited<ReturnType<typeof loadFrozenScript>> = null;
  const frozenPromise = loadFrozenScript(jobId).catch(() => null);
  try {
    catalog = job.catalog_voice_id
      ? await getCatalogVoice(job.catalog_voice_id, {
          hdEnabled: true,
          userId: job.user_id,
        })
      : undefined;
  } catch {
    catalog = undefined;
  }
  existingFrozen = await frozenPromise;

  const voiceId = job.provider_voice_id || catalog?.providerVoiceId;
  if (!voiceId) {
    await failJob(jobId, lease, "Missing provider_voice_id");
    return {
      done: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }

  let ttsOptions = parseTtsOptions(job.tts_options);
  const modelSlug = ttsOptions.model || catalog?.model;
  const catalogMax = catalogMaxForStoredProvider({
    storedProvider: providerId,
    catalogProvider: catalog?.provider,
    catalogMax: catalog?.maxCharsPerRequest,
  });
  const maxChars = maxCharsForModel({
    provider: providerId,
    model: modelSlug,
    catalogMax,
  });
  const hardMaxChars = hardMaxCharsForModel({
    provider: providerId,
    model: modelSlug,
    catalogMax,
    target: maxChars,
  });
  const fanout = await takehomeFanoutCap();

  // Later ticks reuse sections.json — do not re-download the book or re-tag.
  let frozen = existingFrozen;
  if (!frozen) {
    const rawText = await loadBookRaw(job.pdf_storage_path);
    const delivery = resolveDeliverySettings(
      rawText,
      deliveryUserInputFromUnknown(ttsOptions)
    );
    ttsOptions = applyResolvedDelivery(ttsOptions, delivery);
    frozen = await buildAndPersistFrozenScript(jobId, {
      rawText,
      pdfStoragePath: job.pdf_storage_path,
      maxChars,
      hardMaxChars,
      evenFanout: providerId === "fish" ? fanout : undefined,
      normalizeTitles: delivery.normalizeTitles,
      packProvider: providerId,
      deadlineMs: opts?.deadlineMs,
    });
  } else {
    const delivery = resolveDeliverySettings(
      frozen.speakable,
      deliveryUserInputFromUnknown(ttsOptions)
    );
    ttsOptions = applyResolvedDelivery(ttsOptions, delivery);
  }
  const text = frozen.speakable;
  const packed = frozen.sections;
  const sections = packed.map((s) => s.text);
  const total = packed.length;

  if (total === 0) {
    await failJob(jobId, lease, "No text to synthesize");
    return { done: true, nextIndex: 0, total: 0 };
  }

  if (
    typeof ttsOptions.narrationSpeed !== "number" ||
    !Number.isFinite(ttsOptions.narrationSpeed)
  ) {
    ttsOptions = {
      ...ttsOptions,
      narrationSpeed: initialNarrationSpeed({
        catalogVoiceId: job.catalog_voice_id,
        text,
      }),
    };
  }

  if (
    job.total_sections !== total ||
    job.char_count !== text.length ||
    job.tts_options !== JSON.stringify(ttsOptions)
  ) {
    await writeWithLease(
      jobId,
      lease,
      `UPDATE jobs SET total_sections = ?, char_count = ?, tts_options = ?,
         updated_at = unixepoch()
       WHERE id = ? AND processing_lease_token = ?`,
      [total, text.length, JSON.stringify(ttsOptions)]
    );
  }

  let segments = parseSegments(job.segments_json);

  const provider = resolveStockAdapter({
    provider: providerId,
    model: modelSlug,
    catalogVoiceId: job.catalog_voice_id,
  });

  const envPerTick = Number(process.env.TTS_SECTIONS_PER_TICK || String(fanout));
  const maxClaim = Math.min(
    opts?.sectionsPerTick ?? (Number.isFinite(envPerTick) ? envPerTick : fanout),
    fanout,
    5
  );
  const stopAt = opts?.deadlineMs
    ? opts.deadlineMs - tickWriteHeadroomMs(opts.deadlineMs - Date.now())
    : undefined;

  const writeLock = createAsyncMutex();

  if (stopAt && Date.now() >= stopAt) {
    console.log(
      `[Job ${jobId}] tick budget reached before claim — parking queued`
    );
  } else if (!allIndexesReady(segments, total)) {
    const claimed = claimIndexSet({
      segments,
      total,
      fanout: maxClaim,
    });

    if (claimed.length > 0) {
      const nextUnclaimed = lowestUnclaimedAfter(segments, total, claimed);
      await writeWithLease(
        jobId,
        lease,
        `UPDATE jobs SET next_section_index = ?, total_sections = ?,
           status = 'processing', updated_at = unixepoch()
         WHERE id = ? AND processing_lease_token = ?`,
        [nextUnclaimed, total]
      );

      console.log(
        `[Job ${jobId}] claimed indexes [${claimed.join(",")}] next_unclaimed=${nextUnclaimed}`
      );

      const outcomes = await runIndexBoundFanout(
        claimed,
        async (index) => {
          const synthesized = await synthesizeSection({
            jobId,
            index,
            sectionText: sections[index]!,
            frozen: packed[index],
            provider,
            voiceId,
            catalog,
            modelSlug,
            ttsOptions,
          });
          if (!synthesized.ok) {
            await writeLock(async () => {
              const prev = segments.find((s) => s.index === index);
              const nextStatus =
                prev?.status === "retry" ? "failed" : "retry";
              segments = upsertSegment(segments, {
                index,
                path: prev?.path || "",
                status: nextStatus,
                error: synthesized.error,
              });
              const done = readyCount(segments);
              await writeWithLease(
                jobId,
                lease,
                `UPDATE jobs SET next_section_index = ?, segments_json = ?, progress = ?,
                   current_section = ?, total_sections = ?, tts_options = ?,
                   status = 'processing', updated_at = unixepoch()
                 WHERE id = ? AND processing_lease_token = ?`,
                [
                  nextUnclaimed,
                  JSON.stringify(segments),
                  Math.min(99, Math.round((done / total) * 100)),
                  done,
                  total,
                  JSON.stringify(ttsOptions),
                ]
              );
            });
            console.warn(
              `[Job ${jobId}] section ${index} ${synthesized.error} — continuing`
            );
            return synthesized;
          }
          if (synthesized.durationHintSeconds && synthesized.durationHintSeconds > 0) {
            const nextSpeed = calibrateNarrationSpeed({
              currentSpeed:
                ttsOptions.narrationSpeed ?? DEFAULT_NARRATION_SPEED,
              wordCount: wordCount(sections[index]!),
              durationSec: synthesized.durationHintSeconds,
            });
            if (nextSpeed !== (ttsOptions.narrationSpeed ?? DEFAULT_NARRATION_SPEED)) {
              ttsOptions = { ...ttsOptions, narrationSpeed: nextSpeed };
            }
          }

          const uploaded = await uploadFile(
            `audiobooks/${jobId}`,
            sectionObjectName(index, synthesized.extension),
            synthesized.audio,
            synthesized.contentType
          );

          const segment: JobSegment = {
            index,
            path: uploaded.path,
            status: "ready",
            contentType: synthesized.contentType,
            durationSeconds: synthesized.durationHintSeconds,
          };

          await writeLock(async () => {
            segments = upsertSegment(segments, segment);
            const done = readyCount(segments);
            await writeWithLease(
              jobId,
              lease,
              `UPDATE jobs SET next_section_index = ?, segments_json = ?, progress = ?,
                 current_section = ?, total_sections = ?, tts_options = ?,
                 status = 'processing', updated_at = unixepoch()
               WHERE id = ? AND processing_lease_token = ?`,
              [
                nextUnclaimed,
                JSON.stringify(segments),
                Math.min(99, Math.round((done / total) * 100)),
                done,
                total,
                JSON.stringify(ttsOptions),
              ]
            );
          });

          return synthesized;
        },
        claimed.length
      );

      // One bad section must not fail the book — holes stay on the map.
      void outcomes;
    }

    // After the last first-pass index, retry remaining holes once in this tick.
    const holes = claimableIndexes(segments, total);
    if (
      holes.length > 0 &&
      holes.every((i) => segments.some((s) => s.index === i && s.status === "retry"))
    ) {
      const holeSet = holes.slice(0, maxClaim);
      console.log(
        `[Job ${jobId}] hole-retry indexes [${holeSet.join(",")}]`
      );
      await runIndexBoundFanout(
        holeSet,
        async (index) => {
          const synthesized = await synthesizeSection({
            jobId,
            index,
            sectionText: sections[index]!,
            frozen: packed[index],
            provider,
            voiceId,
            catalog,
            modelSlug,
            ttsOptions,
          });
          await writeLock(async () => {
            if (synthesized.ok) {
              const uploaded = await uploadFile(
                `audiobooks/${jobId}`,
                sectionObjectName(index, synthesized.extension),
                synthesized.audio,
                synthesized.contentType
              );
              segments = upsertSegment(segments, {
                index,
                path: uploaded.path,
                status: "ready",
                contentType: synthesized.contentType,
                durationSeconds: synthesized.durationHintSeconds,
              });
            } else {
              const prev = segments.find((s) => s.index === index);
              segments = upsertSegment(segments, {
                index,
                path: prev?.path || "",
                status: "failed",
                error: synthesized.error,
              });
            }
            const done = readyCount(segments);
            await writeWithLease(
              jobId,
              lease,
              `UPDATE jobs SET next_section_index = ?, segments_json = ?, progress = ?,
                 current_section = ?, total_sections = ?, tts_options = ?,
                 status = 'processing', updated_at = unixepoch()
               WHERE id = ? AND processing_lease_token = ?`,
              [
                lowestUnreadyIndex(segments, total),
                JSON.stringify(segments),
                Math.min(99, Math.round((done / total) * 100)),
                done,
                total,
                JSON.stringify(ttsOptions),
              ]
            );
          });
          return synthesized;
        },
        holeSet.length
      );
    }
  }

  const doneCount = readyCount(segments);
  const nextIndex = lowestUnreadyIndex(segments, total);
  const stillClaimable = claimableIndexes(segments, total);
  const canAssemble =
    allIndexesReady(segments, total) ||
    (stillClaimable.length === 0 &&
      (allIndexesReady(segments, total) ||
        mostIndexesReady(segments, total) ||
        doneCount > 0));

  if (canAssemble && doneCount > 0 && stillClaimable.length === 0) {
    const holesLeft = total - doneCount;
    const warning =
      holesLeft > 0
        ? `${holesLeft} section${holesLeft === 1 ? "" : "s"} could not be narrated; the rest of the book is ready.`
        : null;
    let audioPath: string | null = null;
    let markedReady = false;
    const markReady = async (path: string | null) => {
      if (markedReady) return;
      await writeWithLease(
        jobId,
        lease,
        `UPDATE jobs SET status = 'ready', progress = 100, next_section_index = ?,
           segments_json = ?, audio_storage_path = ?, current_section = ?,
           total_sections = ?, warning = ?, error_message = COALESCE(?, error_message),
           processing_lease_token = NULL,
           lease_expires_at = NULL, processing_started_at = NULL,
           updated_at = unixepoch()
         WHERE id = ? AND processing_lease_token = ?`,
        [
          total,
          JSON.stringify(segments),
          path,
          doneCount,
          total,
          warning,
          warning,
        ]
      );
      markedReady = true;
    };
    try {
      audioPath = await materializeFullAudiobook(jobId, segments, total, {
        crossfadeMs:
          typeof ttsOptions.crossfadeMs === "number"
            ? ttsOptions.crossfadeMs
            : undefined,
        allowHoles: holesLeft > 0,
        joinKinds: packed.map((s) => s.joinKind ?? "paragraph"),
        onDryUploaded: async (path) => {
          console.log(
            `[Job ${jobId}] full file uploaded — marking ready`
          );
          await markReady(path);
        },
      });
    } catch (err) {
      console.error(`[Job ${jobId}] failed to materialize full audiobook:`, err);
    }
    if (!audioPath && holesLeft === 0 && !markedReady) {
      await failJob(
        jobId,
        lease,
        "Could not assemble the full audiobook — remux failed"
      );
      return { done: true, nextIndex, total };
    }

    if (!markedReady) {
      await markReady(audioPath);
    }

    await logUsage({
      userId: job.user_id,
      action: "takehome_complete",
      charsProcessed: text.length,
    });

    return { done: true, nextIndex: total, total };
  }

  if (stillClaimable.length === 0 && doneCount === 0) {
    const firstError = segments.find((s) => s.error)?.error;
    await failJob(
      jobId,
      lease,
      firstError ? `Section ${segments[0]?.index}: ${firstError}` : "No audio was produced"
    );
    return { done: true, nextIndex, total };
  }

  await writeWithLease(
    jobId,
    lease,
    `UPDATE jobs SET status = 'queued', next_section_index = ?, progress = ?,
       current_section = ?, processing_lease_token = NULL,
       lease_expires_at = NULL, processing_started_at = NULL,
       updated_at = unixepoch()
     WHERE id = ? AND processing_lease_token = ?`,
    [
      nextIndex,
      Math.min(99, Math.round((doneCount / total) * 100)),
      doneCount,
    ]
  );

  return { done: false, nextIndex, total };
}

async function failJob(
  jobId: string,
  lease: string,
  message: string
): Promise<void> {
  console.error(`[Job ${jobId}] failed: ${message}`);
  await releaseLease(jobId, lease, {
    status: "failed",
    errorMessage: message,
  });
  // `releaseLease` is lease-scoped; if the lease was already reclaimed the
  // failure still needs recording for the user.
  await updateJob(jobId, { status: "failed", error_message: message }).catch(
    () => {}
  );
}

interface SynthesisSuccess {
  ok: true;
  audio: Buffer;
  contentType: string;
  extension: string;
  durationHintSeconds?: number;
}

/**
 * Synthesize one section, retrying transient failures **and silent responses**.
 *
 * A provider that returns 200 with an empty container is the more dangerous
 * failure: stored unchecked it becomes a gap in the finished audiobook. The
 * retry drops accent direction, since over-steered Gemini input is a known
 * cause of empty PCM.
 */
type TtsOptions = {
  model?: string;
  stylePrompt?: string;
  /** Fish `prosody.speed` from first-section heuristic or later calibration. */
  narrationSpeed?: number;
  pauseStyle?: "sparse" | "normal" | "auto";
  crossfadeMs?: number | "auto";
  normalizeTitles?: boolean | "auto";
  deliveryPrefix?: boolean | "auto";
};

function applyResolvedDelivery(
  current: TtsOptions,
  delivery: ResolvedDeliverySettings
): TtsOptions {
  return {
    ...current,
    pauseStyle: delivery.pauseStyle,
    crossfadeMs: delivery.crossfadeMs,
    normalizeTitles: delivery.normalizeTitles,
    deliveryPrefix: delivery.deliveryPrefix,
  };
}

function parseTtsOptions(raw: string | null): TtsOptions {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as TtsOptions;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function synthesizeSection(args: {
  jobId: string;
  index: number;
  sectionText: string;
  frozen?: FrozenSection;
  provider: ReturnType<typeof resolveStockAdapter>;
  voiceId: string;
  catalog: Awaited<ReturnType<typeof getCatalogVoice>>;
  modelSlug?: string;
  ttsOptions: TtsOptions;
}): Promise<SynthesisSuccess | { ok: false; error: string }> {
  const { resolveStylePrompt } = await import("@/lib/tts/resolve-style-prompt");
  const {
    geminiDirectedInput,
    modelSupportsAccentVariants,
    modelSupportsStyleInstructions,
  } = await import("@/lib/tts/accent-prompt");

  const { catalog, modelSlug, ttsOptions, sectionText } = args;
  const modelId = modelSlug || catalog?.model || "";
  const accent =
    catalog?.accentHint ||
    (catalog as { accent?: string } | undefined)?.accent ||
    undefined;
  const supportsDirection = modelSupportsAccentVariants(modelId);
  const supportsStyle = modelSupportsStyleInstructions(modelId);

  let lastError = "TTS failed";

  const synthText = narrationScriptForSynthesis(
    sectionText,
    args.provider.id,
    {
      deliveryPrefix: args.ttsOptions.deliveryPrefix === true,
      pauseStyle:
        args.ttsOptions.pauseStyle === "sparse" ? "sparse" : "normal",
    }
  );

  for (let attempt = 0; attempt < SECTION_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // A rejected request will be rejected again; only retry transient faults.
      if (/40[0134]|invalid|bad request/i.test(lastError)) break;
      if (RETRY_BACKOFF_MS > 0) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
      }
    }

    // Retries fall back to undirected text — aggressive steering is a known
    // trigger for empty Gemini audio. Silent takes stay at Fish `normal`.
    const useDirection = supportsDirection && attempt === 0;
    const latency =
      args.index === 0 && attempt === 0
        ? TAKEHOME_FIRST_SECTION_FISH_LATENCY
        : TAKEHOME_FISH_LATENCY;
    const speed = fishSpeedForRequest(ttsOptions.narrationSpeed);
    const cacheKey = sectionCacheKey({
      text: args.frozen?.text ?? sectionText,
      voiceId: args.voiceId,
      model: modelId,
      latency,
      speed,
      chunkLength: TAKEHOME_FISH_CHUNK_LENGTH,
      variant:
        args.provider.id === "fish"
          ? "fish-plain-v1"
          : usesNarrationPauseScript(args.provider.id)
            ? "fish-cues-oneshot-v1"
            : "",
    });
    const cacheEnabled =
      process.env.TTS_SECTION_CACHE !== "0" &&
      !(process.env.VITEST && process.env.TTS_SECTION_CACHE !== "1");

    try {
      const cached = cacheEnabled
        ? await readSectionCache(cacheKey, "mp3")
        : null;
      if (cached && !isEmptyOrSilentAudio(cached)) {
        return {
          ok: true,
          audio: cached,
          contentType: "audio/mpeg",
          extension: "mp3",
        };
      }

      const result = await withFishSlot(() =>
        args.provider.synthesize({
          text: useDirection
            ? geminiDirectedInput(synthText, accent)
            : synthText,
          voiceId: args.voiceId,
          catalogVoiceId: catalog?.id,
          language: catalog?.locale,
          model: modelSlug,
          latency,
          chunkLength: TAKEHOME_FISH_CHUNK_LENGTH,
          speed,
          stylePrompt:
            supportsDirection || !supportsStyle || attempt > 0
              ? undefined
              : resolveStylePrompt({
                  catalogStylePrompt: catalog?.stylePrompt,
                  ttsOptionsStylePrompt: ttsOptions.stylePrompt,
                  locale: catalog?.locale,
                }),
        })
      );

      if (isEmptyOrSilentAudio(result.audio)) {
        lastError = "provider returned silent audio";
        console.warn(
          `[Job ${args.jobId}] section ${args.index} attempt ${attempt + 1}: silent audio`
        );
        continue;
      }

      const extension = extensionForContentType(result.contentType);
      if (cacheEnabled) {
        await writeSectionCache(
          cacheKey,
          extension,
          result.audio,
          result.contentType
        );
      }

      return {
        ok: true,
        audio: result.audio,
        contentType: result.contentType,
        extension,
        durationHintSeconds: result.durationHintSeconds,
      };
    } catch (err) {
      if (err instanceof FishRateLimitError) {
        lastError = err.message;
        console.warn(
          `[Job ${args.jobId}] section ${args.index} 429 — waiting ${err.retryAfterMs}ms`
        );
        await new Promise((r) => setTimeout(r, err.retryAfterMs));
        continue;
      }
      lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `[Job ${args.jobId}] section ${args.index} attempt ${attempt + 1} failed:`,
        lastError
      );
    }
  }

  return { ok: false, error: lastError };
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("pcm") || contentType.includes("l16")) return "pcm";
  return "mp3";
}

/**
 * Run ticks until the job is done or the invocation's budget runs out.
 * Never HTTP self-calls `/process` — that produced Vercel 508 loops.
 * The VM worker / Trigger use {@link runTakehomeUntilSettled} with a
 * multi-minute budget.
 */
export async function runTakehomeWave(
  jobId: string,
  budgetMs = Number(process.env.TTS_WORKER_WAVE_BUDGET_MS || "240000")
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const maxTicks = Number(process.env.TTS_MAX_TICKS_PER_WAVE || "40");
  // Tight budgets synthesize one section at a time so the caller can respond.
  const sectionsPerTick = budgetMs <= 60_000 ? 1 : undefined;
  let ticks = 0;

  console.log(`[Job ${jobId}] take-home wave starting (budget=${budgetMs}ms)`);

  while (ticks < maxTicks && Date.now() < deadline) {
    ticks += 1;
    try {
      const result = await processTakehomeTick(jobId, {
        deadlineMs: deadline,
        sectionsPerTick,
      });
      if (result.busy) {
        console.log(`[Job ${jobId}] another worker holds the lease`);
        return;
      }
      if (result.done) {
        console.log(`[Job ${jobId}] finished after ${ticks} tick(s)`);
        return;
      }
      console.log(
        `[Job ${jobId}] tick ${ticks}: next=${result.nextIndex}/${result.total}`
      );
    } catch (err) {
      console.error(`[Job ${jobId}] tick ${ticks} failed:`, err);
      return;
    }
  }

  console.warn(
    `[Job ${jobId}] wave paused after ${ticks} tick(s) with work remaining`
  );
}

/** Start or resume generation inside the current worker invocation. */
export async function continueTakehome(
  jobId: string,
  budgetMs?: number
): Promise<void> {
  await runTakehomeWave(jobId, budgetMs);
}

/**
 * VM / Trigger host: keep waving until the job settles. Long budget
 * (minutes), not the poll-nudge cap. Stops on ready / failed / cancelled
 * / lease loss.
 */
export async function runTakehomeUntilSettled(
  jobId: string,
  budgetMs = DEFAULT_TRIGGER_WAVE_BUDGET_MS
): Promise<{ status: string }> {
  const maxWaves = Number(process.env.TTS_MAX_WAVES_PER_RUN || "80");
  for (let wave = 0; wave < maxWaves; wave++) {
    const job = await queryOne<{ status: string }>(
      `SELECT status FROM jobs WHERE id = ? AND deleted_at IS NULL`,
      [jobId]
    );
    if (!job) return { status: "missing" };
    if (
      job.status === "ready" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return { status: job.status };
    }

    try {
      await runTakehomeWave(jobId, budgetMs);
    } catch (err) {
      if (err instanceof LeaseLostError) {
        return { status: "lease_lost" };
      }
      throw err;
    }

    const after = await queryOne<{ status: string }>(
      `SELECT status FROM jobs WHERE id = ? AND deleted_at IS NULL`,
      [jobId]
    );
    if (!after) return { status: "missing" };
    if (
      after.status === "ready" ||
      after.status === "failed" ||
      after.status === "cancelled"
    ) {
      return { status: after.status };
    }
  }

  return { status: "queued" };
}

/**
 * Return jobs whose worker died mid-flight (lease expired without a heartbeat)
 * to the queue. Cheap enough for UI poll paths to call.
 */
export async function releaseExpiredTakehomeLeases(): Promise<number> {
  try {
    const result = await execute(
      `UPDATE jobs SET status = 'queued', processing_lease_token = NULL,
         lease_expires_at = NULL, processing_started_at = NULL,
         updated_at = unixepoch()
       WHERE deleted_at IS NULL
         AND job_kind = 'takehome'
         AND status = 'processing'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= unixepoch()`
    );
    const n = result.rowsAffected;
    if (n > 0) {
      console.log(`[leases] returned ${n} abandoned job(s) to the queue`);
    }
    return n;
  } catch (err) {
    console.error("[leases] release failed:", err);
    return 0;
  }
}

/** Take-home jobs waiting for a worker, oldest first. */
export async function listQueuedTakehomeJobs(limit = 3): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE deleted_at IS NULL
       AND job_kind = 'takehome'
       AND status = 'queued'
     ORDER BY updated_at ASC
     LIMIT ?`,
    [limit]
  );
  return rows.map((r) => r.id);
}

/**
 * Trigger drain: queued take-homes plus processing rows whose lease expired.
 * Deduped by job id.
 */
export async function listDrainableTakehomeJobs(limit = 50): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE deleted_at IS NULL
       AND job_kind = 'takehome'
       AND (
         status = 'queued'
         OR (
           status = 'processing'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= unixepoch()
         )
       )
     ORDER BY updated_at ASC
     LIMIT ?`,
    [limit]
  );
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Advance queued take-home jobs. This is the worker entry point used by both
 * the cron route and the internal `/process` route.
 */
export async function drainTakehomeQueue(opts?: {
  limit?: number;
  budgetMs?: number;
}): Promise<{ picked: number }> {
  await ensureTtsJobColumns();
  await releaseExpiredTakehomeLeases();

  const limit = opts?.limit ?? Number(process.env.TTS_CRON_JOBS_PER_RUN || "3");
  const totalBudget =
    opts?.budgetMs ?? Number(process.env.TTS_WORKER_WAVE_BUDGET_MS || "240000");
  const ids = await listQueuedTakehomeJobs(limit);
  if (ids.length === 0) return { picked: 0 };

  const deadline = Date.now() + totalBudget;
  let picked = 0;
  for (const id of ids) {
    const remaining = deadline - Date.now();
    if (remaining <= 10_000) break;
    picked += 1;
    await runTakehomeWave(id, remaining);
  }
  return { picked };
}

/**
 * UI poll paths call this. It always performs the cheap lease sweep; it only
 * synthesizes when `TTS_POLL_NUDGE_BUDGET_MS` is non-zero, which exists so
 * deployments without a frequent cron schedule still make progress. Set it to
 * `0` once cron is running and polls become pure reads.
 *
 * Default: one queued job and a shared wall-clock budget so Hobby polls return
 * before the 60s function timeout (chaining two full waves caused 504s).
 */
export async function nudgeStaleTakehomeJobs(limit = 1): Promise<number> {
  const budgetMs = pollNudgeBudgetMs();
  const released = await releaseExpiredTakehomeLeases();
  if (budgetMs <= 0) return released;

  try {
    const ids = await listQueuedTakehomeJobs(limit);
    if (ids.length === 0) return 0;
    const deadline = Date.now() + budgetMs;
    let advanced = 0;
    for (const id of ids) {
      const remaining = deadline - Date.now();
      // Need headroom to claim + write; otherwise park for the next poll.
      if (remaining < 5_000) break;
      await runTakehomeWave(id, remaining);
      advanced += 1;
    }
    return advanced;
  } catch (err) {
    console.error("[nudge] failed:", err);
    return released;
  }
}

/** Same as {@link nudgeStaleTakehomeJobs}, scoped to one job the user is watching. */
export async function nudgeStaleTakehomeJobIfNeeded(job: {
  id: string;
  job_kind?: string | null;
  status: string;
  updated_at: number;
}): Promise<void> {
  if (job.job_kind !== "takehome") return;
  if (job.status === "ready" || job.status === "failed") return;

  const budgetMs = pollNudgeBudgetMs();
  try {
    await releaseExpiredTakehomeLeases();
    if (budgetMs <= 0) return;
    await runTakehomeWave(job.id, budgetMs);
  } catch (err) {
    console.error(`[Job ${job.id}] nudge failed:`, err);
  }
}
