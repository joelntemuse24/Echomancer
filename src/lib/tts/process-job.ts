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
 * Trigger.dev `takehome.advance` remains an optional fallback when
 * `WORKER_URL` is unset or `TAKEHOME_TRIGGER_FALLBACK=1`. `takehome.drain`
 * is not scheduled from this repo; turn the live dashboard schedule off.
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

import { deleteFile, downloadFile } from "@/lib/storage";
import { execute, query, queryOne } from "@/lib/turso";
import { isTransientWorkerError } from "@/lib/transient-error";
import { logUsage } from "@/lib/turso/jobs";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import {
  loadCloneReference,
  modalCloneBatchSize,
  modalCloneLaneCount,
  ModalCloneColdError,
  ModalCloneProviderError,
  ModalCloneReferenceError,
  renderModalCloneBatch,
  usesModalClone,
} from "@/lib/tts/providers/modal-clone";
import {
  CpuProviderUnavailableError,
  MASTERING_UNFINISHED_MESSAGE,
  MODAL_WORKSPACE_DISABLED_MESSAGE,
  ModalWorkspaceDisabledError,
} from "@/lib/modal/workspace-disabled";
import { incompleteAudiobookMessage, userFriendlyError } from "@/lib/errors-ui";
import { modalCloneSectionChars, modalLaneCharLimit } from "@/lib/tts/providers/modal-clone-lanes";
import { cloneNarrationRecipeId } from "@/lib/tts/clone-narration-recipe";
import { prewarmModalCloneSnapshot } from "@/lib/tts/providers/modal-clone-warm";
import {
  shouldPrewarmBeforeOutline,
  shouldPrewarmModalNarration,
} from "@/lib/tts/modal-narration-warm";
import { dispatchModalCloneLanes } from "@/lib/tts/providers/modal-clone-dispatch";
import {
  selectClonePublishBatch,
  selectCloneRenderIndexes,
} from "@/lib/tts/providers/modal-clone-prefetch";
import {
  CLONE_COLD_TIMEOUT_WARNING,
  CLONE_PROVIDER_FAULT_WARNING,
  modalCloneDeferMs,
  modalCloneFirstLightEnabled,
  parseCloneProviderPin,
  resolveLegacyDramaPin,
  type CloneProviderChoice,
} from "@/lib/tts/providers/modal-clone-guard";
import { withCloneBatchSlot } from "@/lib/tts/fish-slots";
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
import {
  isPlayableBookPath,
  isSectionStoragePath,
  materializeFullAudiobook,
} from "@/lib/tts/concat-audio";
import { isRetiredGoogleSynthesis } from "@/lib/tts/standard-voice";
import { GEORGE_CACHE_VARIANT } from "@/lib/tts/george-voice";
import {
  planSowellLanes,
  SOWELL_CACHE_VARIANT,
  sowellBookLanes,
} from "@/lib/tts/sowell-voice";
import { CpuBacklogError, CpuSaturatedError } from "@/lib/cpu/errors";
import { cpuYieldSeconds } from "@/lib/cpu/deadlines";
import { holdBookConcat } from "@/lib/cpu/runner";
import { commitSectionAudio, promoteFinishedSections, recoverOrphanRawSections } from "@/lib/cpu/section-publish";
import { requeueExpiredCpuTasks } from "@/lib/cpu/tasks";
import { runInsideCpuTask } from "@/lib/cpu/task-slot";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import {
  catalogMaxForStoredProvider,
  FISH_HARD_MAX_CHARS,
  hardMaxCharsForModel,
  maxCharsForModel,
} from "@/lib/tts/section-size";
import {
  allIndexesReady,
  claimIndexSet,
  claimableIndexes,
  SECTION_FANOUT_HARD_MAX,
  createAsyncMutex,
  lowestUnclaimedAfter,
  lowestUnreadyIndex,
  nextClaimableIndex,
  parseSegmentMap,
  readyCount,
  runIndexBoundFanout,
  runRollingIndexPool,
  upsertSegment,
} from "@/lib/tts/section-index";
import {
  readSectionCache,
  sectionCacheKey,
  writeSectionCache,
} from "@/lib/tts/section-cache";
import {
  FISH_ACCOUNT_CONCURRENCY,
  cloneTakehomeFanoutCap,
  takehomeFanoutCap,
  withFishSlot,
} from "@/lib/tts/fish-slots";
import {
  bindEdgeGoogleGate,
  createInFlightGate,
  edgeGoogleInFlightLimit,
  edgeGoogleSectionConcurrency,
  isEdgeOrGoogleProvider,
  isUpstreamThrottle,
  noteEdgeGoogleThrottle,
  type InFlightGate,
} from "@/lib/tts/section-concurrency";
import {
  markTakehomeServed,
  takehomeAdmissionSql,
  takehomeClaimSql,
  takehomeInflightCap,
} from "@/lib/jobs/takehome-fairness";
import {
  holdEdgeSectionSlot,
  holdNamedProviderSlot,
  paradeeSharedCap,
  ProviderSlotBusyError,
  readProviderThrottle,
  releaseProviderSlotsForOwner,
  renewTakehomeProviderSlots,
} from "@/lib/tts/provider-slots";
import { takehomeLeaseContext } from "@/lib/tts/takehome-lease-context";
import { edgeSectionBudgetMs } from "@/lib/tts/edge-tts";
import { FishRateLimitError } from "@/lib/tts/providers/fish";
import type { FishLatency } from "@/lib/tts/providers/fish";
import { qaRegenerationBudgetMs, settleSectionTake, type SpeechRate } from "@/lib/tts/transcript-qa";
import {
  guardSectionSqueaks,
  resolveSqueakGuard,
  type SqueakGuardContext,
} from "@/lib/tts/section-squeak-guard";
import {
  getUploadByStoragePath,
  uploadStatus,
} from "@/lib/turso/uploads";
import { estimatePriceEur } from "@/lib/tts/pricing";

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

/**
 * Fish runs near 37 characters a second in production (about 216–250s for an
 * 8,000–9,200 character section). Budget at 10 characters a second plus a
 * minute so a full section is not aborted. The clock starts after the account
 * slot is acquired; queue time is not part of this budget.
 */
const FISH_ATTEMPT_CHARS_PER_SEC = 10;
const FISH_ATTEMPT_SLACK_MS = 60_000;
/**
 * Wall clock for one synthesize attempt. Fish and the other non-Edge adapters
 * use the generous speech rate. Edge and Google cover every chunk wave and
 * retry inside {@link edgeSectionBudgetMs}, so the outer abort cannot fire
 * before the last chunk attempt.
 */
export function sectionAttemptBudgetMs(providerId: string, text: string): number {
  if (providerId === "edge" || providerId === "google") {
    return edgeSectionBudgetMs(text);
  }
  if (providerId === "paradee") {
    return paradeeAttemptBudgetMs(text.length);
  }
  return fishAttemptBudgetMs(text.length);
}

function fishAttemptBudgetMs(chars: number): number {
  return Math.ceil(chars / FISH_ATTEMPT_CHARS_PER_SEC) * 1000 + FISH_ATTEMPT_SLACK_MS;
}

/**
 * The self-hosted CPU student runs slower than hosted TTS: budget 20 chars per
 * second and allow three times that, with a 60s floor for a short section.
 */
const PARADEE_ATTEMPT_CHARS_PER_SEC = 20;
export function paradeeAttemptBudgetMs(chars: number): number {
  return Math.max(60_000, Math.ceil((chars / PARADEE_ATTEMPT_CHARS_PER_SEC) * 1000) * 3);
}

/** Paradee sections in flight for one book. */
export const PARADEE_FANOUT_DEFAULT = 3;
export function paradeeFanout(): number {
  return paradeeSharedCap() || PARADEE_FANOUT_DEFAULT;
}

type LeaseCover = { jobId: string; untilMs: number };
const leaseCovers = new Set<LeaseCover>();

/**
 * Mark a stretch of work that must keep the lease. `untilMs` is the attempt's
 * own deadline. A wave that has passed its budget still renews while any
 * cover is inside that deadline, and stops once every cover has lapsed.
 */
export function coverLeaseUntil(
  jobId: string,
  untilMs: number
): { until: (ms: number) => void; end: () => void } {
  const cover: LeaseCover = { jobId, untilMs };
  leaseCovers.add(cover);
  return {
    until(ms: number) {
      cover.untilMs = ms;
    },
    end() {
      leaseCovers.delete(cover);
    },
  };
}

/**
 * After synthesis, mastering and the upload still have to finish. A batch of
 * eight sections was observed to need about a minute there. Three minutes
 * covers that and still lets a stuck ffmpeg drop the lease.
 */
export const SECTION_MASTER_LEASE_MS = 180_000;

/**
 * Whole section, from the moment it is claimed: every synth attempt, the
 * retry backoff, then mastering, upload, and the segments write. A step that
 * ignores its own timeout still hits this ceiling.
 */
export function sectionLifecycleCapMs(providerId: string, text: string): number {
  const attempt = sectionAttemptBudgetMs(providerId, text);
  const backoff = Math.max(0, RETRY_BACKOFF_MS) * ((SECTION_ATTEMPTS * (SECTION_ATTEMPTS - 1)) / 2);
  return SECTION_ATTEMPTS * attempt + backoff + qaRegenerationBudgetMs(attempt) + SECTION_MASTER_LEASE_MS;
}

function openSectionLifecycle(
  jobId: string,
  providerId: string,
  text: string
): { mastering: () => void; end: () => void } {
  const ceiling = Date.now() + sectionLifecycleCapMs(providerId, text);
  const life = coverLeaseUntil(jobId, ceiling);
  return {
    mastering() {
      life.until(Math.min(ceiling, Date.now() + SECTION_MASTER_LEASE_MS));
    },
    end() {
      life.end();
    },
  };
}

/**
 * Jobs whose full-book concat is running. A finalize has its own encode
 * budget (tens of minutes for a whole book), so the wave deadline says
 * nothing about when it ends: keep renewing until the concat returns.
 */
const finalizingJobIds = new Set<string>();

/** Mark a job's full-audiobook concat as running. `end` must run in a `finally`. */
export function markJobFinalizing(jobId: string): { end: () => void } {
  finalizingJobIds.add(jobId);
  return {
    end() {
      finalizingJobIds.delete(jobId);
    },
  };
}

/**
 * Renew unless the wave budget is over and no section is still inside its
 * lifecycle cap (synth, retries, master, upload, segments write) and the
 * full-book concat is not running.
 */
export function shouldRenewTakehomeLease(opts: {
  now: number;
  waveDeadlineMs?: number;
  jobId: string;
}): boolean {
  const wave = opts.waveDeadlineMs;
  if (wave == null || !Number.isFinite(wave) || opts.now <= wave) return true;
  if (finalizingJobIds.has(opts.jobId)) return true;
  for (const cover of leaseCovers) {
    if (cover.jobId === opts.jobId && opts.now <= cover.untilMs) return true;
  }
  return false;
}

/**
 * Leases this process claimed and has not released. Shutdown matches these
 * tokens; it does not clear a lease another worker holds.
 */
const inFlightTakehomeLeases = new Map<string, string>();

function holdInFlightTakehomeLease(jobId: string, token: string) {
  inFlightTakehomeLeases.set(jobId, token);
}

function dropInFlightTakehomeLease(jobId: string, token: string) {
  if (inFlightTakehomeLeases.get(jobId) === token) {
    inFlightTakehomeLeases.delete(jobId);
  }
}

/**
 * Hand this process's open leases back to `queued`. Same UPDATE as
 * {@link releaseLease}, matched to the token we still hold.
 */
export async function releaseInFlightTakehomeLeases(): Promise<number> {
  const held = [...inFlightTakehomeLeases.entries()];
  for (const [jobId, token] of held) {
    // Slots first. A crash between the two still leaves the lease, which the
    // next boot can reclaim, rather than a permit with no owner process.
    await releaseProviderSlotsForOwner(token).catch((err) => {
      console.error(`[Job ${jobId}] slot release failed`, err);
    });
    await releaseLease(jobId, token, { status: "queued" });
    dropInFlightTakehomeLease(jobId, token);
  }
  return held.length;
}

const SECTION_ATTEMPTS = 3;

/** Fish `latency=normal` — most stable output for sections 1+. Live keeps `balanced`. */
export const TAKEHOME_FISH_LATENCY = "normal" as const;

/** Section 0 only — lower time-to-first-audio so the player can start sooner. */
export const TAKEHOME_FIRST_SECTION_FISH_LATENCY = "balanced" as const;

/**
 * The latency a take is stored under, from its index and attempt.
 *
 * Section 0's first take is allowed the faster profile. The lane prefetch and
 * the per-section path must agree on this: they both write and read the same
 * content-addressed cache entry, and a mismatch made every prefetched section 0
 * a cache miss — so publishing it paid for a second GPU call and the first
 * audio arrived later than the prefetch suggested.
 */
export function takehomeCacheLatency(
  index: number,
  attempt = 0
): FishLatency {
  return index === 0 && attempt === 0
    ? TAKEHOME_FIRST_SECTION_FISH_LATENCY
    : TAKEHOME_FISH_LATENCY;
}

/**
 * The cache variant a take is stored under.
 *
 * Part of the content-addressed key, so it moves whenever the spoken script
 * recipe changes. Kept here rather than inline in the synth loop because the
 * clone lane prefetch writes entries this loop later reads: two copies of this
 * decision meant a prefetched take could be stored where nothing looks for it.
 */
export function takehomeCacheVariant(
  providerId: string,
  catalogVoiceId?: string | null
): string {
  if (providerId === "fish") {
    if (usesModalClone(catalogVoiceId)) {
      // The **recipe** is part of the identity, not just the engine.
      //
      // `s2-pro-modal-v1` named the engine and a hand-maintained version, so
      // #244's 300-char units, #245's 400-char units and #246's 560-char units
      // all hashed the same. `job 75944dc9` was assembled from takes recorded
      // under the two older recipes while its own runtime rendered nothing, so
      // the new narration never played and the book looked like a speed change.
      // See `clone-narration-recipe.ts` for what is (and is not) included.
      return `s2-pro-modal-${cloneNarrationRecipeId()}`;
    }
    // No drama-3 variant exists any more: a take from that engine is a
    // different voice, so it must never be found under a clone's key.
    return "fish-plain-v1";
  }
  // Paragraph-level packing with trimmed joins. Bumped so takes from the
  // per-sentence pipeline are never replayed.
  if (providerId === "paradee") return "paradee-paragraph-v1";
  if (providerId === "sowell") return SOWELL_CACHE_VARIANT;
  if (providerId === "george") return GEORGE_CACHE_VARIANT;
  return usesNarrationPauseScript(providerId) ? "fish-cues-oneshot-v1" : "";
}

/**
 * The one content-addressed key for a take-home section.
 *
 * The per-section path and the clone lane prefetch both go through this. They
 * used to build it separately, and the lane copy was wrong in two ways at once
 * (a fixed `normal` latency for section 0, and a fixed `s2-pro-modal-v1`
 * variant regardless of engine), which turned every prefetched section into a
 * cache miss for the path that publishes it.
 */
export function takehomeSectionCacheKey(opts: {
  text: string;
  voiceId: string;
  model: string;
  index: number;
  attempt?: number;
  speed?: number;
  providerId: string;
  catalogVoiceId?: string | null;
}): string {
  return sectionCacheKey({
    text: opts.text,
    voiceId: opts.voiceId,
    model: opts.model,
    latency: takehomeCacheLatency(opts.index, opts.attempt ?? 0),
    speed: opts.speed,
    chunkLength: TAKEHOME_FISH_CHUNK_LENGTH,
    variant: takehomeCacheVariant(opts.providerId, opts.catalogVoiceId),
  });
}

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
  audio_storage_path: string | null;
  /** Clone engine this book is committed to; null while undecided. */
  provider_pin?: string | null;
  /** Unix time this book started waiting for a cold clone pool. */
  clone_wait_started_at?: number | null;
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
  const admission = takehomeAdmissionSql();
  const result = await execute(
    `UPDATE jobs SET status = 'processing',
       processing_lease_token = ?,
       lease_expires_at = unixepoch() + ?,
       processing_started_at = unixepoch(),
       generation_started_at = COALESCE(generation_started_at, unixepoch()),
       sched_not_before = NULL,
       updated_at = unixepoch()
     WHERE id = ? AND deleted_at IS NULL
       AND status IN ('queued', 'processing', 'waiting')
       AND (processing_lease_token IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at <= unixepoch())${admission.sql}`,
    [token, ttlSeconds, jobId, ...admission.args]
  );
  if (result.rowsAffected <= 0) return null;
  await markTakehomeServed(jobId);
  return token;
}

async function takehomeLeaseStopped(jobId: string, lease: string): Promise<boolean> {
  const row = await queryOne<{
    status: string;
    deleted_at: number | null;
    processing_lease_token: string | null;
  }>(
    `SELECT status, deleted_at, processing_lease_token FROM jobs WHERE id = ?`,
    [jobId]
  );
  if (!row || row.deleted_at != null || row.status === "cancelled") return true;
  return row.processing_lease_token !== lease;
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
  patch: {
    status: "queued" | "waiting" | "failed";
    errorMessage?: string | null;
    /** Seconds before the drain may claim this book again. 0 clears the delay. */
    notBeforeSec?: number;
  }
): Promise<void> {
  const delay = patch.notBeforeSec && patch.notBeforeSec > 0 ? patch.notBeforeSec : 0;
  await execute(
    `UPDATE jobs SET status = ?, error_message = COALESCE(?, error_message),
       processing_lease_token = NULL, lease_expires_at = NULL,
       processing_started_at = NULL,
       sched_not_before = CASE WHEN ? > 0 THEN unixepoch() + ? ELSE NULL END,
       updated_at = unixepoch()
     WHERE id = ? AND processing_lease_token = ?`,
    [patch.status, patch.errorMessage ?? null, delay, delay, jobId, token]
  );
}

/**
 * Keep the lease alive while a section is in flight. Without this, any section
 * slower than the TTL would be handed to a second worker mid-synthesis.
 */
function startLeaseHeartbeat(
  jobId: string,
  token: string,
  opts?: { deadlineMs?: number }
) {
  let lost = false;
  let paused = false;
  const timer = setInterval(() => {
    if (
      !shouldRenewTakehomeLease({
        now: Date.now(),
        waveDeadlineMs: opts?.deadlineMs,
        jobId,
      })
    ) {
      if (!paused) {
        paused = true;
        console.warn(
          `[lease] heartbeat paused past wave budget for ${jobId} (no section still inside its lifecycle cap)`
        );
      }
      return;
    }
    paused = false;
    void heartbeatLease(jobId, token)
      .then(async (held) => {
        if (!held) {
          lost = true;
          return;
        }
        await renewTakehomeProviderSlots(token, LEASE_TTL_SECONDS).catch((err) => {
          console.warn(
            `[lease] provider-slot renew skipped for ${jobId}`,
            err instanceof Error ? err.message : err
          );
        });
      })
      .catch((err) => {
        if (isTransientWorkerError(err)) {
          console.warn(
            `[lease] heartbeat skipped for ${jobId}`,
            err instanceof Error ? err.message : err
          );
          return;
        }
        console.error(`[lease] heartbeat failed for ${jobId}`, err);
        throw err;
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
/** Shown on a book whose sections could not be joined into one file. */
export const UNJOINED_BOOK_WARNING =
  "This book could not be joined into one file, so it plays section by section. Retry to rebuild the full download.";

/**
 * Which clone engine a brand-new book is committed to.
 *
 * This is the deliberate provider-selection boundary: after it runs once the
 * answer is stored, and no per-section failure may change it. Order is the
 * documented product order — self-hosted S2-Pro when it is configured,
 * otherwise direct Fish. Drama 3 is never chosen: it does not speak the clone,
 * so its takes are a different voice.
 *
 * There is **no allowance** in this decision. Until 2026-11-07 a per-account
 * daily character budget could pin a book to Fish before it rendered a section;
 * that is what refused `job 75944dc9` at 492,425 characters used and reported
 * itself as a provider fault. The engine is chosen by configuration only.
 */
export function resolveCloneProviderPin(opts: {
  modalConfigured: boolean;
  env: NodeJS.ProcessEnv;
}): CloneProviderChoice {
  const explicit = (opts.env.CLONE_TTS_PROVIDER || "").trim().toLowerCase();
  if (explicit === "fish") return "fish";
  // `openrouter` used to mean "Drama 3 only". Drama 3 is gone, so the honest
  // reading of that leftover value is "do not use the GPU pool".
  if (explicit === "openrouter") return "fish";
  return opts.modalConfigured ? "modal" : "fish";
}

/**
 * A section that did not render.
 *
 * `cold` means the GPU pool had nothing warm: the book is parked, not failed.
 * `fatal` means retrying cannot help (an unusable clone reference).
 * `providerFault` means Modal itself answered with a hard error (a 5xx that is
 * not a cold gateway, or unusable audio). That is not a cold start, so it must
 * not park the book as if a container were coming: the tick falls through to
 * the existing defer / fallback path instead of failing with a spent retry.
 */
export interface SynthesisFailure {
  ok: false;
  error: string;
  cold?: boolean;
  fatal?: boolean;
  providerFault?: boolean;
}

/**
 * Retry generation for the whole tick.
 *
 * Sections claimed but not yet stored carry their own attempt count; the
 * highest one is the epoch. A retry therefore renders a different take, while
 * a fresh section renders under epoch 0 and stays reproducible.
 */
export function cloneSeedEpoch(segments: JobSegment[]): number {
  let epoch = 0;
  for (const segment of segments) {
    if (segment.status === "retry") epoch = Math.max(epoch, 1);
  }
  return epoch;
}

/**
 * Park a book whose GPU pool has nothing warm.
 *
 * Nothing in the browser is waiting on this book, so the correct answer to a
 * cold pool is "not yet": the row goes back to `queued`, the lease is released,
 * and the drain retries with the defer clock. Only when the clock runs out does
 * the book continue on the fallback engine, and it says so on the job.
 *
 * Returns the engine to continue with: `true` means "stop this tick and park",
 * `false` means "carry on" (because deferral is off, or the budget is spent and
 * the book has just been pinned to the fallback).
 */
async function deferForColdClonePool(opts: {
  jobId: string;
  lease: string;
  job: StockJobRow;
  stagedCount: number;
  /**
   * Why the book is waiting. Kept as a parameter because a hard Modal provider
   * fault parks here too: the clock and the fallback are the same, but the log
   * line and the warning on the finished book must name the real cause.
   */
  reason?: "cold" | "provider-fault";
  lastError?: string | null;
}): Promise<{ park: true } | { park: false; switched: boolean }> {
  const { jobId, lease, job, stagedCount } = opts;
  const providerFault = opts.reason === "provider-fault";
  const label = providerFault ? "Modal provider fault" : "GPU pool cold";
  const warning = providerFault
    ? CLONE_PROVIDER_FAULT_WARNING
    : CLONE_COLD_TIMEOUT_WARNING;
  const budget = modalCloneDeferMs();
  const nowSec = Math.floor(Date.now() / 1000);
  if (budget <= 0) {
    console.warn(
      `[Job ${jobId}] ${label} and MODAL_S2_DEFER_MS=0 — continuing on the fallback engine`
    );
    return { park: false, switched: false };
  }
  const started = Number(job.clone_wait_started_at ?? 0);
  if (!started) {
    // First cold (or faulty) answer for this book: start the clock and park it.
    await execute(
      `UPDATE jobs SET clone_wait_started_at = COALESCE(clone_wait_started_at, ?),
         updated_at = unixepoch()
       WHERE id = ? AND processing_lease_token = ?`,
      [nowSec, jobId, lease]
    ).catch(() => undefined);
    console.log(
      `[Job ${jobId}] ${label} after ${stagedCount} staged — parking` +
        (opts.lastError ? ` (${opts.lastError.slice(0, 200)})` : "")
    );
    await releaseLease(jobId, lease, { status: "queued" }).catch(() => {});
    return { park: true };
  }
  const waitedMs = (nowSec - started) * 1000;
  if (waitedMs < budget) {
    console.log(
      `[Job ${jobId}] ${label} after ${Math.round(waitedMs / 1000)}s ` +
        `of ${Math.round(budget / 1000)}s — parking again`
    );
    await releaseLease(jobId, lease, { status: "queued" }).catch(() => {});
    return { park: true };
  }
  // Out of patience. Fall back for the REST of the book, not this section, and
  // record why so the finished book is not silently a different narrator.
  //
  // The fallback is **direct Fish**, not Drama 3: Fish is the account that
  // trained this clone, so it speaks the same voice. Drama 3 re-cloned the raw
  // sample through a hosted model, and its takes were audibly a neighbour of
  // the customer's voice — which is exactly the substitution that put a Drama
  // render under an S2 preview key on 2026-11-06.
  const fallback: CloneProviderChoice = fishFallbackAvailable()
    ? "fish"
    : "modal";
  if (fallback === "modal") {
    // Nothing to switch to. Say so instead of quietly changing voices, and
    // leave the book queued on its cold clock rather than failing it outright:
    // the drain retries while the pool comes back.
    console.warn(
      `[Job ${jobId}] ${label} for ${Math.round(waitedMs / 1000)}s and no Fish ` +
        `fallback is configured — parking without substituting a voice`
    );
    await releaseLease(jobId, lease, { status: "queued" }).catch(() => {});
    return { park: true };
  }
  console.warn(
    `[Job ${jobId}] ${label} for ${Math.round(waitedMs / 1000)}s — ` +
      `switching this book to direct Fish (the same voice)` +
      (opts.lastError ? `: ${opts.lastError.slice(0, 200)}` : "")
  );
  await execute(
    `UPDATE jobs SET provider_pin = 'fish',
       warning = COALESCE(warning, ?), updated_at = unixepoch()
     WHERE id = ? AND processing_lease_token = ?`,
    [warning, jobId, lease]
  ).catch(() => undefined);
  return { park: false, switched: true };
}

/**
 * Whether direct Fish can serve as the clone engine.
 *
 * It is the one honest fallback: Fish trained the reference, so it speaks the
 * same voice. Without a key there is no second engine, and the book keeps
 * waiting on the pool rather than being handed a different narrator.
 */
export function fishFallbackAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(
    (env.FISH_API_KEY || env.FISH_AUDIO_API_KEY || "").trim()
  );
}

/**
 * Park a book whose Modal engine answered with a **hard** fault.
 *
 * Distinct from a cold pool in what it means, identical in what it does: the
 * provider is reachable but broken (`job 5f09ee0e` returned
 * `500 TypeError: open() got an unexpected keyword argument 'metadata_errors'`
 * on every lane). The book keeps its narrator while the deploy is fixed, and
 * only takes the documented fallback once the defer budget is spent.
 */
async function deferForProviderFault(opts: {
  jobId: string;
  lease: string;
  job: StockJobRow;
  message: string;
}): Promise<{ park: true } | { park: false; switched: boolean }> {
  return deferForColdClonePool({
    jobId: opts.jobId,
    lease: opts.lease,
    job: opts.job,
    stagedCount: 0,
    reason: "provider-fault",
    lastError: opts.message,
  });
}

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
  deferred?: boolean;
  /** Release this process slot so another book can run. */
  yieldSlot?: boolean;
}> {
  await ensureTtsJobColumns();

  const job = await queryOne<StockJobRow>(
    `SELECT id, user_id, status, pdf_storage_path, book_title, voice_name,
            tts_provider, provider_voice_id, catalog_voice_id, tts_options,
            segments_json, next_section_index, total_sections, char_count,
            job_kind, generation_mode, audio_storage_path, provider_pin,
            clone_wait_started_at
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

  holdInFlightTakehomeLease(jobId, lease);
  const heartbeat = startLeaseHeartbeat(jobId, lease, {
    deadlineMs: opts?.deadlineMs,
  });
  try {
    return await takehomeLeaseContext.run({ token: lease, jobId }, () =>
      runClaimedTick(job, lease, opts)
    );
  } catch (err) {
    if (
      err instanceof ModalWorkspaceDisabledError ||
      err instanceof CpuProviderUnavailableError
    ) {
      await stopBook(jobId, lease, MODAL_WORKSPACE_DISABLED_MESSAGE, null).catch(() => {});
      return {
        done: true,
        nextIndex: job.next_section_index ?? 0,
        total: job.total_sections ?? 0,
      };
    }
    if (
      err instanceof ListenPrepDeferredError ||
      err instanceof ProviderSlotBusyError ||
      err instanceof CpuBacklogError
    ) {
      const yieldSlot = err instanceof CpuBacklogError;
      console.log(
        `[Job ${jobId}] ${
          err instanceof ProviderSlotBusyError
            ? "shared provider cap is full"
            : err instanceof CpuBacklogError
              ? "cpu work is queued"
              : "listen-prep needs a later tick"
        }`
      );
      await releaseLease(jobId, lease, {
        status: "queued",
        // A full provider cap can free a slot as soon as the section that
        // held it finishes, so the same book must stay claimable. A book
        // that is only waiting on a CPU container must not spin.
        notBeforeSec: yieldSlot ? cpuYieldSeconds() : 0,
      }).catch(() => {});
      return {
        done: false,
        busy: true,
        deferred: true,
        yieldSlot,
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
    dropInFlightTakehomeLease(jobId, lease);
  }
}

async function runClaimedTick(
  job: StockJobRow,
  lease: string,
  opts?: { deadlineMs?: number; sectionsPerTick?: number }
): Promise<{
  done: boolean;
  nextIndex: number;
  total: number;
  busy?: boolean;
  deferred?: boolean;
}> {
  const jobId = job.id;
  const providerId = job.tts_provider || "";

  // A new clone book restores a GPU snapshot before its first section can
  // render, so the restore overlaps packing. A book that already has an
  // outline does not: concat, saved raw, and a later cache check must not
  // start a container. The call is one RPC, never awaited, and the app stays
  // `min_containers=0`.
  const knownTotal = job.total_sections ?? 0;
  if (
    shouldPrewarmBeforeOutline({
      modalVoice: usesModalClone(job.catalog_voice_id),
      clonePin: parseCloneProviderPin(job.provider_pin),
      totalSections: knownTotal,
      claimableCount:
        knownTotal > 0
          ? claimableIndexes(parseSegments(job.segments_json), knownTotal).length
          : 0,
    })
  ) {
    prewarmModalCloneSnapshot(`book ${jobId} is starting`);
  }

  // A job may be created while its upload is still extracting, so the first
  // thing a tick does is wait its turn: park the job as `waiting` until the
  // text exists, and fail it once the upload itself has failed. `waiting` is
  // outside the legacy Trigger drain's `queued` / `processing` claim. Both
  // leave the lease clean. The path was owner-checked when the job was
  // created (`getOwnedUploadByPath`); this lookup does not re-check.
  const upload = job.pdf_storage_path
    ? await getUploadByStoragePath(job.pdf_storage_path).catch(() => null)
    : null;
  if (upload) {
    const uploadState = uploadStatus(upload);
    if (uploadState === "failed") {
      await failJob(
        jobId,
        lease,
        upload.error_message || "Couldn't read this. Try another file."
      );
      return {
        done: true,
        nextIndex: job.next_section_index ?? 0,
        total: job.total_sections ?? 0,
      };
    }
    if (uploadState !== "ready") {
      console.log(
        `[Job ${jobId}] waiting for extract (${uploadState}) — parking waiting`
      );
      await releaseLease(jobId, lease, { status: "waiting" }).catch(() => {});
      return {
        done: false,
        busy: true,
        deferred: true,
        nextIndex: job.next_section_index ?? 0,
        total: job.total_sections ?? 0,
      };
    }
  }

  if (
    isRetiredGoogleSynthesis({
      provider: providerId,
      providerVoiceId: job.provider_voice_id,
    })
  ) {
    return parkStoredGoogleJob(job, lease);
  }

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

  // The sample is a few megabytes from object storage. On a warm GPU that
  // download sits in front of section 0; on a cold one it hides inside the
  // restore. Start it now so it overlaps packing either way. A pin that is
  // already another engine does not need the bytes. (A legacy `drama3` row is
  // re-pinned above, so it arrives here as `modal` or `fish`.)
  const cloneReferenceId = catalog?.id ?? job.catalog_voice_id;
  const storedPin = parseCloneProviderPin(job.provider_pin);
  const earlyReference: Promise<Awaited<ReturnType<typeof loadCloneReference>> | Error> | null =
    cloneReferenceId &&
    usesModalClone(cloneReferenceId) &&
    storedPin !== "fish"
      ? loadCloneReference(cloneReferenceId, voiceId).catch((err) =>
          err instanceof Error ? err : new Error(String(err))
        )
      : null;

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
  /**
   * Pack width for this book.
   *
   * The self-hosted clone path is the one case where a section must fit inside
   * a **single GPU call**, because a row renders its paragraph units in
   * sequence and a call's wall time is set by its longest row. Packing it at the
   * Fish ceiling produced ~7.7k sections on `job 7e4a8b48` that no call budget
   * could render. Every other provider keeps its existing packing.
   */
  const clonePacked = usesModalClone(job.catalog_voice_id);
  const packChars = clonePacked
    ? Math.min(maxChars, modalCloneSectionChars())
    : maxChars;
  const kokoroBook = providerId === "sowell" || providerId === "george";
  const sowellCap = kokoroBook ? sowellBookLanes() : 0;
  let fanout =
    kokoroBook
      ? sowellCap
      : providerId === "paradee"
        ? paradeeFanout()
      : usesModalClone(job.catalog_voice_id)
        ? // Clones come from our own containers, not Fish: no 5-slot account
          // cap. The batch prefetch already fills the GPU, so this stays small.
          await cloneTakehomeFanoutCap()
        : isEdgeOrGoogleProvider(providerId)
          ? edgeGoogleInFlightLimit()
          : await takehomeFanoutCap();
  if (isEdgeOrGoogleProvider(providerId)) {
    // Another process may already have halved the shared cap after a 429.
    // Starting a full local wave would take the slots, then defer the book.
    const shared = await readProviderThrottle("edge");
    if (shared != null) fanout = Math.max(1, Math.min(fanout, shared));
  }

  // Later ticks reuse sections.json — do not re-download the book or re-tag.
  //
  // One exception: a clone book frozen when sections were sized for the model
  // rather than for a call (`job 7e4a8b48` froze four 7.7k sections, and a row
  // of that size needs ~154s of generation — more than the hard ceiling allows
  // a call). That outline is not just badly packed, it is unusable: no lane,
  // retry or split can render a row that is longer than a whole call. Re-pack
  // it once, and only while nothing has been published, so a book already in
  // progress never changes under the player.
  let frozen = existingFrozen;
  const frozenTooWide =
    Boolean(frozen) &&
    clonePacked &&
    frozen!.sections.length > 0 &&
    Math.max(...frozen!.sections.map((section) => section.text.length)) > packChars &&
    parseSegments(job.segments_json).every(
      (segment) => segment.status !== "ready" && segment.status !== "mastering"
    );
  if (frozenTooWide) {
    console.warn(
      `[Job ${jobId}] clone sections were packed wider than one call can render ` +
        `(max ${Math.max(...frozen!.sections.map((section) => section.text.length))} chars > ` +
        `${packChars}); re-packing before the first section renders`
    );
    frozen = null;
  }
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
      maxChars: packChars,
      hardMaxChars: clonePacked ? packChars : hardMaxChars,
      // Even packing is for parallel Fish workers, where sections only need to
      // be similar to each other. A clone section is bounded by what one GPU
      // call can render, and the remainder-absorbing pass that goes with even
      // packing is allowed to grow the last section past its target — which
      // would hand the clone path a row it cannot finish.
      evenFanout:
        providerId === "fish" && !clonePacked ? fanout : undefined,
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
  if (kokoroBook) {
    // One lane per section still to speak, and no more than the configured
    // cap. Two sections already fill the live fleet. A third container
    // would not have had a section on the 1,480-character book.
    fanout = planSowellLanes({ remainingSections: total, cap: sowellCap });
  }

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
    // The job was created before the text existed, so its stored size and
    // price came from zero characters. The first tick that sees the real
    // text corrects both.
    const price = catalog
      ? estimatePriceEur({ charCount: text.length, voice: catalog })
      : null;
    await writeWithLease(
      jobId,
      lease,
      `UPDATE jobs SET total_sections = ?, char_count = ?, tts_options = ?,
         price_estimate_eur = COALESCE(?, price_estimate_eur),
         updated_at = unixepoch()
       WHERE id = ? AND processing_lease_token = ?`,
      [total, text.length, JSON.stringify(ttsOptions), price?.suggestedPriceEur ?? null]
    );
  }

  let segments = parseSegments(job.segments_json);
  const recovered = await recoverOrphanRawSections({
    jobId,
    segments,
    total,
    sectionText: (index) => sections[index] ?? "",
  });
  if (recovered.recovered > 0) {
    segments = recovered.segments;
    await writeWithLease(
      jobId,
      lease,
      `UPDATE jobs SET segments_json = ?, updated_at = unixepoch()
       WHERE id = ? AND processing_lease_token = ?`,
      [JSON.stringify(segments)]
    );
  }
  const promoted = await promoteFinishedSections(jobId, segments);
  if (promoted.changed) {
    segments = promoted.segments;
    await writeWithLease(
      jobId,
      lease,
      `UPDATE jobs SET segments_json = ?, updated_at = unixepoch()
       WHERE id = ? AND processing_lease_token = ?`,
      [JSON.stringify(segments)]
    );
  }
  if (promoted.unavailable) {
    await stopBook(jobId, lease, MODAL_WORKSPACE_DISABLED_MESSAGE, null);
    return {
      done: true,
      nextIndex: job.next_section_index ?? 0,
      total: job.total_sections ?? 0,
    };
  }
  let cpuBacklog = promoted.waiting;

  const provider = resolveStockAdapter({
    provider: providerId,
    model: modelSlug,
    catalogVoiceId: job.catalog_voice_id,
  });

  const envPerTick = Number(process.env.TTS_SECTIONS_PER_TICK || String(fanout));
  const clonePath = usesModalClone(job.catalog_voice_id);
  /**
   * How many sections one tick may claim.
   *
   * For the self-hosted clone path the useful unit is the **batch**, not the
   * lane count. One call carries up to `MODAL_S2_BATCH_SIZE` rows and decodes
   * them in a single pass, so claiming only `lanes` sections per tick (4) left
   * a 24-row call carrying one row — the 2.9x-instead-of-35–65x collapse
   * measured on `job db10a6d6`. The lane count still caps how many calls are
   * open at once; it does not cap how much work one call may carry.
   *
   * An explicit `sectionsPerTick` still wins: a tight-budget wave uses it to
   * synthesize one section at a time so the caller can answer, and a test uses
   * it to pin a tick to one section.
   */
  const claimDefault = clonePath
    ? Math.max(fanout, modalCloneBatchSize())
    : Number.isFinite(envPerTick)
      ? envPerTick
      : fanout;
  const claimRequest = opts?.sectionsPerTick ?? claimDefault;
  // Non-clone paths keep the account/fan-out ceiling they always had. The
  // clone path is the one place `batch` — not `lanes` — is the useful unit,
  // because one call decodes all of its rows in a single GPU pass.
  const claimCeiling = clonePath
    ? Math.max(fanout, modalCloneBatchSize())
    : kokoroBook
      ? sowellCap
      : providerId === "paradee"
        ? fanout
      : isEdgeOrGoogleProvider(providerId)
        ? edgeGoogleInFlightLimit()
        : FISH_ACCOUNT_CONCURRENCY;
  const maxClaim = clonePath
    ? Math.min(claimRequest, claimCeiling)
    : Math.min(claimRequest, fanout, claimCeiling);
  const stopAt = opts?.deadlineMs
    ? opts.deadlineMs - tickWriteHeadroomMs(opts.deadlineMs - Date.now())
    : undefined;

  // Pin the clone engine for this book before any section renders.
  //
  // Decided once and stored on the row, so a container that is slow at section
  // 3 cannot hand section 4 to a different engine. `provider_pin` wins over the
  // current env, which means changing `CLONE_TTS_PROVIDER` mid-book does not
  // change a book that is already running.
  let clonePin: CloneProviderChoice | null = parseCloneProviderPin(job.provider_pin);
  const cloneVoice = usesModalClone(catalog?.id ?? job.catalog_voice_id)
    || Boolean(catalog?.id?.startsWith("clone:"))
    || Boolean(job.catalog_voice_id?.startsWith("clone:"));
  // A book stored before Drama 3 was removed is re-pinned to an engine that
  // actually speaks this clone. Its already-stored sections stay untouched;
  // only what is left to render moves.
  if (clonePin === "drama3" && cloneVoice) {
    const rewritten = resolveLegacyDramaPin({
      modalConfigured: usesModalClone(catalog?.id ?? job.catalog_voice_id),
    });
    console.warn(
      `[Job ${jobId}] legacy drama3 pin resolved to ${rewritten}` +
        " (Drama 3 is no longer a clone engine)"
    );
    await execute(
      `UPDATE jobs SET provider_pin = ?, updated_at = unixepoch()
       WHERE id = ? AND provider_pin = 'drama3'`,
      [rewritten, jobId]
    ).catch(() => undefined);
    clonePin = rewritten;
  }
  if (cloneVoice && !clonePin) {
    clonePin = resolveCloneProviderPin({
      modalConfigured: usesModalClone(catalog?.id ?? job.catalog_voice_id),
      env: process.env,
    });
    await execute(
      `UPDATE jobs SET provider_pin = ?, updated_at = unixepoch()
       WHERE id = ? AND processing_lease_token = ? AND provider_pin IS NULL`,
      [clonePin, jobId, lease]
    ).catch(() => undefined);
    console.log(`[Job ${jobId}] clone provider pinned to ${clonePin}`);
  }

  const writeLock = createAsyncMutex();
  const speechRate: SpeechRate = { chars: 0, seconds: 0 };
  // Clone voices only: reference pitch profile for the per-section squeak guard.
  const squeakGuard = await resolveSqueakGuard({
    userId: job.user_id,
    catalogVoiceId: catalog?.id ?? job.catalog_voice_id,
    providerId: provider.id,
  }).catch(() => null);
  const edgeGate: InFlightGate | null = isEdgeOrGoogleProvider(providerId)
    ? createInFlightGate(maxClaim)
    : null;
  if (edgeGate) bindEdgeGoogleGate(edgeGate);

  if (stopAt && Date.now() >= stopAt) {
    console.log(
      `[Job ${jobId}] tick budget reached before claim — parking queued`
    );
  } else if (!allIndexesReady(segments, total)) {
    /**
     * One section, correct on both claim orders: a first-pass failure is
     * parked as `retry` (one more hole attempt later in this tick or a later
     * tick), and a retry failure becomes permanently `failed`. Results go
     * into `segments_json` with an index-stable object name, so a restarted
     * worker reuses what is stored and re-claims only unfinished sections.
     */
    let cloneColdSeen = false;
    // Set when this tick already rendered and published the clone batch.
    // The generic claim below would otherwise speak the same sections again,
    // one row per call, including takes that are already in the section cache.
    let modalPrefetchHandled = false;
    // A shared cap that is only partly free. Sections that already hold a
    // slot finish and write before the tick returns the book to the queue.
    let providerCapFull = false;
    /**
     * The last hard provider fault (a non-cold 5xx / unusable audio) seen in
     * this tick, if any. Presence means the Modal engine answered and its
     * answer was an error, so the tick should follow the defer → fallback path
     * rather than fail the book on a section that has spent its retries.
     */
    let cloneProviderFaultSeen: string | null = null;
    const processSection = async (
      index: number,
      nextWriteIndex: () => number,
      sectionOpts?: { skipSectionQa?: boolean }
    ): Promise<SynthesisSuccess | SynthesisFailure> => {
      if (await takehomeLeaseStopped(jobId, lease)) {
        throw new LeaseLostError(jobId);
      }
      const capacitySlot =
        providerId === "edge" || providerId === "google"
          ? await holdEdgeSectionSlot(edgeGoogleSectionConcurrency())
          : providerId === "paradee"
            ? await holdNamedProviderSlot("paradee", paradeeFanout())
            : kokoroBook
              ? await holdNamedProviderSlot("kokoro", sowellCap)
            : providerId === "fish"
              ? null
              : await holdNamedProviderSlot(
                  providerId,
                  FISH_ACCOUNT_CONCURRENCY
                );
      const life = openSectionLifecycle(
        jobId,
        provider.id,
        sections[index]!
      );
      let slotReleased = false;
      const releaseSlot = async () => {
        if (slotReleased) return;
        slotReleased = true;
        await capacitySlot?.release();
      };
      try {
        const synthesized = await synthesizeChecked(
          {
            jobId,
            index,
            sectionText: sections[index]!,
            frozen: packed[index],
            provider,
            voiceId,
            catalog,
            modelSlug,
            ttsOptions,
            clonePin,
            squeakGuard,
            skipSectionQa: sectionOpts?.skipSectionQa === true,
          },
          speechRate
        );
        if (!synthesized.ok) {
          if (synthesized.cold) {
            // A cold pool is not this section's fault, so it must not spend
            // one of the section's two attempts. The caller parks the book.
            cloneColdSeen = true;
            console.warn(
              `[Job ${jobId}] section ${index} parked — ${synthesized.error}`
            );
            return synthesized;
          }
          if (synthesized.providerFault) {
            // Modal answered with a hard error, not a cold placement. Record it
            // as this section's error but *also* set the provider-fault flag so
            // the tick falls through to the defer → fallback path. Failing the
            // book here is what produced "Section 0: Modal clone already
            // retried" on `job 5f09ee0e` instead of the provider's real message.
            cloneProviderFaultSeen = synthesized.error;
            console.warn(
              `[Job ${jobId}] section ${index} Modal provider fault — ${synthesized.error}`
            );
          }
          await writeLock(async () => {
            const prev = segments.find((s) => s.index === index);
            const nextStatus = prev?.status === "retry" ? "failed" : "retry";
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
                nextWriteIndex(),
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
        if (
          // Modal never receives narrationSpeed. Calibrating from that
          // duration moves the cache key and the staged take looks missing,
          // so the next section pays for the same audio again.
          clonePin !== "modal" &&
          provider.id !== "paradee" &&
          synthesized.durationHintSeconds &&
          synthesized.durationHintSeconds > 0
        ) {
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

        // Speech is finished. Mastering and the final join are separate
        // CPU placements. Holding this permit through them keeps the next
        // section from speaking.
        await releaseSlot();
        life.mastering();
        const stored = await commitSectionAudio({
          jobId,
          index,
          audio: synthesized.audio,
          extension: synthesized.extension,
          contentType: synthesized.contentType,
          chain: usesModalClone(catalog?.id) ? "s2" : "podcast",
          qaDeferred: synthesized.qaDeferred === true,
          sourceText: sections[index],
        });
        if (!stored.ready) {
          const segment: JobSegment = {
            index,
            path: "",
            status: stored.regen ? "retry" : "mastering",
            contentType: stored.contentType,
            durationSeconds: synthesized.durationHintSeconds,
            rawPath: stored.rawPath,
            error: stored.regen ? "transcript check asked for another take" : undefined,
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
                nextWriteIndex(),
                JSON.stringify(segments),
                Math.min(99, Math.round((done / total) * 100)),
                done,
                total,
                JSON.stringify(ttsOptions),
              ]
            );
          });
          if (stored.unavailable) throw new CpuProviderUnavailableError();
          if (!stored.regen) cpuBacklog = true;
          return synthesized;
        }

        const segment: JobSegment = {
          index,
          path: stored.path,
          status: "ready",
          contentType: stored.contentType,
          durationSeconds: synthesized.durationHintSeconds,
          mastered: stored.mastered,
          rawPath: stored.rawPath,
        };

        await writeLock(async () => {
          segments = upsertSegment(segments, segment);
          const done = readyCount(segments);
          await writeWithLease(
            jobId,
            lease,
            `UPDATE jobs SET next_section_index = ?, segments_json = ?, progress = ?,
               current_section = ?, total_sections = ?, tts_options = ?,
               first_section_at = COALESCE(first_section_at, unixepoch()),
               last_section_at = unixepoch(),
               status = 'processing', updated_at = unixepoch()
             WHERE id = ? AND processing_lease_token = ?`,
            [
              nextWriteIndex(),
              JSON.stringify(segments),
              Math.min(99, Math.round((done / total) * 100)),
              done,
              total,
              JSON.stringify(ttsOptions),
            ]
          );
        });

        return synthesized;
      } finally {
        await releaseSlot();
        life.end();
      }
    };

    const workSection = async (
      index: number,
      nextWriteIndex: () => number,
      sectionOpts?: { skipSectionQa?: boolean }
    ): Promise<SynthesisSuccess | SynthesisFailure> => {
      try {
        return await processSection(index, nextWriteIndex, sectionOpts);
      } catch (err) {
        if (!(err instanceof ProviderSlotBusyError)) throw err;
        // Do not mark the section failed. The pool keeps the sections that
        // already acquired a slot running until they write.
        providerCapFull = true;
        return { ok: false, error: err.message };
      }
    };

    // Self-hosted clones: render this tick's uncached sections across the GPU
    // lanes. The container decodes each section as its own row of one batch,
    // so GPU cost is nearly flat in rows-per-call (measured 2.9x realtime
    // one-per-call, 35x at 24 per call), and four lanes means four independent
    // one-GPU containers. Indexes that already have a take are not sent again:
    // the publish window is 8 and the batch is 24, so the next tick used to
    // re-render the staged tail (`S2 lane staged` is a GPU row, not a cache hit).
    //
    // Section 0 goes first, alone, and is published before any other lane
    // opens. Nothing is playable until it is, and a lane call answers all of
    // its rows together — so a fan-out that batches section 0 with a neighbour
    // holds the first audio back until the neighbour is done too. On an empty
    // pool it also spent a full four-container cold start before one second
    // was playable (`job db10a6d6`, 2026-11-06: ~4m38s to ready on a 5-section
    // book, section 0 not first).
    //
    // Each rendered section lands in the same object the per-section path
    // reads. A section the batch did not return stays uncached and is tried
    // again on the next batch. The one-row path runs only when the dispatch
    // itself throws before staging anything.
    //
    // A cold pool parks the book instead of switching narrator: the job is
    // asynchronous, so "come back in a minute" is strictly better than
    // "different voice from section 7".
    if (clonePin === "modal") {
      const pendingAll = claimableIndexes(segments, total);
      if (pendingAll.length >= 1) {
        const batch = modalCloneBatchSize();
        const maxLaneChars = modalLaneCharLimit();
        // Frozen for the tick. Modal does not receive this speed; letting a
        // later calibration change it would store the take where the publish
        // path does not look.
        const prefetchSpeed = fishSpeedForRequest(ttsOptions.narrationSpeed);
        const cacheOn =
          process.env.TTS_SECTION_CACHE !== "0" &&
          !(process.env.VITEST && process.env.TTS_SECTION_CACHE !== "1");
        const cacheKeyFor = (index: number) =>
          takehomeSectionCacheKey({
            text: sections[index]!,
            voiceId,
            model: modelSlug ?? "",
            index,
            speed: prefetchSpeed,
            providerId: provider.id,
            catalogVoiceId: catalog?.id ?? job.catalog_voice_id,
          });
        const reusable = async (index: number): Promise<boolean> => {
          if (!cacheOn) return false;
          // A retry wants a new take. The previous one is why it is marked.
          if (segments.some((segment) => segment.index === index && segment.status === "retry")) {
            return false;
          }
          const audio = await readSectionCache(cacheKeyFor(index), "mp3");
          return Boolean(audio && !isEmptyOrSilentAudio(audio));
        };
        try {
          const referenceId = catalog?.id ?? job.catalog_voice_id;
          if (!referenceId) throw new Error("clone voice id is missing");
          const loadedReference = earlyReference
            ? await earlyReference
            : await loadCloneReference(referenceId, voiceId);
          if (loadedReference instanceof Error) throw loadedReference;
          const reference = loadedReference;
          const seedEpoch = cloneSeedEpoch(segments);
          const cachedAtStart = new Set<number>();
          if (cacheOn) {
            let misses = 0;
            for (const index of pendingAll) {
              if (misses >= maxClaim) break;
              if (await reusable(index)) cachedAtStart.add(index);
              else misses += 1;
            }
          }
          const { render, skippedCached } = selectCloneRenderIndexes(
            pendingAll,
            (index) => cachedAtStart.has(index),
            maxClaim
          );
          const lanes = Math.max(
            1,
            Math.min(modalCloneLaneCount(), Math.max(render.length, 1))
          );
          // Section 0 is alone only when this tick is the one that renders it.
          const needsFirstLight = modalCloneFirstLightEnabled() && render[0] === 0;
          const stagedNow = new Set<number>();
          const stageSection = async (
            index: number,
            audio: Buffer,
            durationSeconds: number
          ): Promise<void> => {
            await writeSectionCache(cacheKeyFor(index), "mp3", audio, "audio/mpeg");
            stagedNow.add(index);
            console.log(
              `[Job ${jobId}] S2 lane staged section ${index} (${durationSeconds}s)`
            );
          };
          const publishIndexes = async (indexes: number[]) => {
            if (indexes.length === 0) return;
            const nextUnclaimed = lowestUnclaimedAfter(segments, total, indexes);
            await writeWithLease(
              jobId,
              lease,
              `UPDATE jobs SET next_section_index = ?, total_sections = ?,
                 status = 'processing', updated_at = unixepoch()
               WHERE id = ? AND processing_lease_token = ?`,
              [nextUnclaimed, total]
            );
            console.log(
              `[Job ${jobId}] publishing staged sections [${indexes.join(",")}]`
            );
            await runIndexBoundFanout(
              indexes,
              (index) => workSection(index, () => nextUnclaimed),
              indexes.length
            );
          };

          let dispatch: Awaited<ReturnType<typeof dispatchModalCloneLanes>> | null = null;
          // Cache hits and a tick with nothing left to render must not start
          // a restore. A real miss still starts one before the GPU call.
          if (
            shouldPrewarmModalNarration({
              modalVoice: usesModalClone(job.catalog_voice_id),
              clonePin,
              uncachedRenderCount: render.length,
            })
          ) {
            prewarmModalCloneSnapshot(`book ${jobId} has uncached narration`);
          }
          const renderPromise =
            render.length === 0
              ? Promise.resolve(null)
              : withCloneBatchSlot(() =>
                  dispatchModalCloneLanes({
                    indexes: render,
                    textAt: (index) => sections[index]!,
                    lanes,
                    batch,
                    maxLaneChars,
                    seedEpoch,
                    firstLight: needsFirstLight,
                    // Section 0 goes through the real per-section path so mastering,
                    // upload, `segments_json` and `first_section_at` all happen for
                    // it while the other lanes are still rendering.
                    publishFirstLight: async (index) => {
                      // Transcript QA spawns a fresh Whisper process. That model
                      // load sits between the GPU returning and `first_section_at`.
                      // Section 0 is published without it; every later section is
                      // still checked. The take is not swapped afterwards, because
                      // the player may already be reading the object.
                      await workSection(
                        index,
                        () => lowestUnreadyIndex(segments, total),
                        { skipSectionQa: true }
                      );
                    },
                    render: (items, epoch, renderOpts) =>
                      renderModalCloneBatch(items, reference, undefined, jobId, {
                        seedEpoch: epoch,
                        raceForFirstAudio: renderOpts?.raceForFirstAudio === true,
                        workMs: renderOpts?.workMs,
                      }),
                    stage: stageSection,
                    log: (message) => console.log(`[Job ${jobId}] ${message}`),
                  })
                ).catch((err: unknown) => {
                  if (err instanceof ModalWorkspaceDisabledError) throw err;
                  console.warn(
                    `[Job ${jobId}] S2 lane dispatch failed; per-section path decides:`,
                    err instanceof Error ? err.message : err
                  );
                  return null;
                });

          // Already-staged takes are mastered while the next batch renders.
          // The GPU call is not awaited until that prefix is published, or
          // until there is nothing staged yet.
          let publishedFromCache = 0;
          const attempted = new Set<number>();
          const blocked = new Set(render);
          try {
            while (!cpuBacklog && !(stopAt && Date.now() >= stopAt)) {
              const batchIndexes = selectClonePublishBatch(
                claimableIndexes(segments, total).filter((index) => !attempted.has(index)),
                (index) => cachedAtStart.has(index),
                blocked,
                SECTION_FANOUT_HARD_MAX
              );
              if (batchIndexes.length === 0) break;
              for (const index of batchIndexes) attempted.add(index);
              await publishIndexes(batchIndexes);
              publishedFromCache += batchIndexes.length;
            }
          } finally {
            dispatch = await renderPromise;
          }

          if (dispatch) {
            console.log(
              `[Job ${jobId}] S2 lanes=${lanes} batch=${batch} staged=${dispatch.staged}/${render.length} ` +
                `cacheSkip=${skippedCached} ` +
                `containers=${dispatch.containers.join(",") || "-"} ` +
                `builds=${dispatch.builds.join(",") || "-"} ` +
                `boot=${dispatch.boot.join(",") || "-"} gen=${dispatch.generateSeconds}s` +
                (dispatch.firstLight
                  ? ` first=${dispatch.firstLight.index}:` +
                    `${dispatch.firstLight.staged ? "staged" : "missed"}` +
                    `@${Math.round(dispatch.firstLight.elapsedMs / 1000)}s`
                  : "")
            );
          } else if (render.length === 0 && skippedCached > 0) {
            console.log(`[Job ${jobId}] S2 cacheSkip=${skippedCached} render=0`);
          }

          if (dispatch?.cold) {
            const outcome = await deferForColdClonePool({
              jobId,
              lease,
              job,
              stagedCount: dispatch.staged,
            });
            if (outcome.park) {
              return {
                done: false,
                busy: true,
                deferred: true,
                nextIndex: job.next_section_index ?? 0,
                total: job.total_sections ?? 0,
              };
            }
            if (outcome.switched) {
              // The row is pinned to the fallback from here on. Adopt that in
              // memory too, or the remaining sections would keep calling a
              // pool this book has already given up on.
              clonePin = "fish";
            }
          }

          if (clonePin === "modal") {
            // Nothing was staged at the start of the tick, so the player still
            // needs a window of the takes this GPU call just wrote. Later
            // ticks master that tail while the next batch is rendering.
            if (
              publishedFromCache === 0 &&
              !cpuBacklog &&
              !(stopAt && Date.now() >= stopAt)
            ) {
              const fresh = selectClonePublishBatch(
                claimableIndexes(segments, total).filter((index) => !attempted.has(index)),
                (index) => stagedNow.has(index),
                new Set(),
                SECTION_FANOUT_HARD_MAX
              );
              if (fresh.length > 0) await publishIndexes(fresh);
            }
            // A dispatch that neither staged nor published did not take the
            // book forward. The per-section path still has to see a cold pool
            // or a hard provider fault. Once a take is staged, or an older
            // take was published, that path would speak the misses one row at
            // a time, so the next batch does it.
            modalPrefetchHandled = stagedNow.size > 0 || publishedFromCache > 0;
          }
        } catch (err) {
          if (err instanceof ModalWorkspaceDisabledError) throw err;
          if (err instanceof LeaseLostError) throw err;
          console.warn(
            `[Job ${jobId}] S2 lane dispatch failed; per-section path decides:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    if (isEdgeOrGoogleProvider(providerId) && edgeGate) {
      // Rolling pool for Edge / Google: a slot claims the next claimable
      // section as soon as the previous one finishes, so the lanes stay full
      // and one slow or stalled section never parks the ones behind it.
      // Claims are in-memory only — every finished section writes
      // `segments_json`, so a restarted worker claims the remainder again.
      const claimedSet = new Set<number>();
      const claimsPerTick = opts?.deadlineMs
        ? opts.sectionsPerTick ?? Number.POSITIVE_INFINITY
        : maxClaim;
      let claimsLeft = claimsPerTick;
      console.log(
        `[Job ${jobId}] rolling pool concurrency=${maxClaim} claims_per_tick=${
          Number.isFinite(claimsPerTick) ? claimsPerTick : "deadline"
        }`
      );
      await runRollingIndexPool({
        concurrency: maxClaim,
        gate: edgeGate,
        shouldStop: () =>
          providerCapFull || Boolean(stopAt && Date.now() >= stopAt),
        claimNext: async () => {
          if (claimsLeft <= 0) return null;
          if (await takehomeLeaseStopped(jobId, lease)) {
            throw new LeaseLostError(jobId);
          }
          const index = nextClaimableIndex(segments, total, claimedSet);
          if (index === null) return null;
          if (Number.isFinite(claimsLeft)) claimsLeft -= 1;
          claimedSet.add(index);
          await writeWithLease(
            jobId,
            lease,
            `UPDATE jobs SET next_section_index = ?, total_sections = ?,
               status = 'processing', updated_at = unixepoch()
             WHERE id = ? AND processing_lease_token = ?`,
            [lowestUnclaimedAfter(segments, total, [...claimedSet]), total]
          );
          return index;
        },
        work: (index) =>
          workSection(
            index,
            () => lowestUnclaimedAfter(segments, total, [...claimedSet])
          ),
      });
    } else if (!modalPrefetchHandled) {
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

        // One bad section must not fail the book — holes stay on the map.
        await runIndexBoundFanout(
          claimed,
          (index) => workSection(index, () => nextUnclaimed),
          claimed.length,
          edgeGate ?? undefined
        );
      }
    }

    // The cap stopped this wave. In-flight sections have already written.
    // Hand the book back without opening another wave of provider calls.
    if (providerCapFull) throw new ProviderSlotBusyError("provider");

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
        (index) =>
          workSection(index, () => lowestUnreadyIndex(segments, total)),
        holeSet.length,
        edgeGate ?? undefined
      );
    }

    if (providerCapFull) throw new ProviderSlotBusyError("provider");

    // A section that could not be placed inside the restore budget must not
    // open another compile-length wait. Park the book here, with its sections
    // already stored. The snapshot, if one was abandoned, is the off-path RPC.
    if (cloneColdSeen) {
      const outcome = await deferForColdClonePool({
        jobId,
        lease,
        job,
        stagedCount: readyCount(segments),
      });
      if (outcome.park) {
        return {
          done: false,
          busy: true,
          deferred: true,
          nextIndex: job.next_section_index ?? 0,
          total: job.total_sections ?? 0,
        };
      }
      if (outcome.switched) clonePin = "fish";
    } else if (cloneProviderFaultSeen && clonePin === "modal") {
      // Modal answered with a hard error. That is neither cold nor this book's
      // fault, so it must not burn the cold clock: wait out a short defer and,
      // if the fault is still there when the budget is spent, take the same
      // documented fallback the cold path uses. The provider's own message is
      // carried into the log so the real cause (`TypeError: ... metadata_errors`
      // on `job 5f09ee0e`) is visible instead of "Modal clone already retried".
      console.warn(
        `[Job ${jobId}] Modal provider fault this tick: ${cloneProviderFaultSeen}`
      );
      const outcome = await deferForProviderFault({
        jobId,
        lease,
        job,
        message: cloneProviderFaultSeen,
      });
      if (outcome.park) {
        return {
          done: false,
          busy: true,
          deferred: true,
          nextIndex: job.next_section_index ?? 0,
          total: job.total_sections ?? 0,
        };
      }
      if (outcome.switched) clonePin = "fish";
    }
  }

  if (edgeGate) bindEdgeGoogleGate(null);

  const doneCount = readyCount(segments);
  const nextIndex = lowestUnreadyIndex(segments, total);
  const stillClaimable = claimableIndexes(segments, total);
  /**
   * A book is only finished when every index is ready.
   *
   * This used to also accept `mostIndexesReady` (more than half) or simply
   * `doneCount > 0`, so a book with holes was published `ready` with a warning.
   * `job 75944dc9` took that to its extreme: 5 of 11 sections, a 510 s file
   * against a 1,069 s source, and a `ready` row — 55% of the book simply absent
   * while the UI and every `status === "ready"` consumer treated it as complete.
   *
   * The already-rendered audio is still worth keeping (the warning and
   * section-by-section playback stay, and nothing is deleted), but it must not
   * be presented as the whole book. So assembly still happens — a listener can
   * hear what exists — and the job is marked `failed` with the exact shortfall
   * instead of `ready`. `failed` is the one status every consumer already
   * treats as "not the finished book", and `error_message` is where a person
   * looks for why.
   */
  if (cpuBacklog || segments.some((segment) => segment.status === "mastering")) {
    throw new CpuBacklogError();
  }

  const complete = allIndexesReady(segments, total);
  const canAssemble = complete || (stillClaimable.length === 0 && doneCount > 0);

  if (canAssemble && doneCount > 0 && stillClaimable.length === 0) {
    const holesLeft = total - doneCount;
    if (holesLeft > 0) {
      // A partial book is not concatenated and is not marked ready.
      // Sections that already have a raw take were spoken; mastering
      // did not finish. Sections with no raw take were not narrated.
      const withRaw = segments.filter(
        (segment) => segment.status === "failed" && Boolean(segment.rawPath)
      );
      const message =
        holesLeft - withRaw.length <= 0 && withRaw.length > 0
          ? MASTERING_UNFINISHED_MESSAGE
          : incompleteAudiobookMessage(doneCount, total);
      await stopBook(
        jobId,
        lease,
        message,
        Math.min(99, Math.round((doneCount / total) * 100))
      );
      console.log(
        `[Job ${jobId}] only ${doneCount}/${total} sections are ready — marking FAILED, not concatenating`
      );
      return { done: true, nextIndex: total, total };
    }
    const warning =
      holesLeft > 0
        ? `${holesLeft} section${holesLeft === 1 ? "" : "s"} could not be narrated; the rest of the book is ready.`
        : null;
    let audioPath: string | null = null;
    let uploadedPath: string | null = null;
    let markedReady = false;
    // The user deleted or cancelled the job while we were finalizing. The
    // uploaded file must be removed instead of published.
    let publishRefused = false;
    const markReady = async (path: string | null) => {
      if (markedReady || publishRefused || !path) return;
      // The concat fallback ships audiobooks/<id>/sections.zip. Publishing it
      // as the book would hand the player a zip as its <audio src>. Every
      // section is still ready, so publish the book without a full file: the
      // player streams it section by section and the warning says why.
      const playable = isPlayableBookPath(path);
      if (!playable) {
        console.error(
          `[Job ${jobId}] not publishing ${path} as the book file: not a playable audio file`
        );
      }
      // A book missing sections is **not** the finished book, whatever audio
      // exists. It is published as `failed` with the shortfall spelled out, so
      // the player, the library, the download and every `status === "ready"`
      // consumer stop treating a partial render as complete (`job 75944dc9`:
      // 5 of 11 sections, 510 s of a 1,069 s source). The stored audio and the
      // section rows are untouched, so nothing a listener can already hear is
      // lost, and `failed` is the status the UI already labels as not done.
      const publishedStatus = complete ? "ready" : "failed";
      const failureMessage = complete
        ? null
        : incompleteAudiobookMessage(doneCount, total);
      const readySql = `UPDATE jobs SET status = ?, progress = ?, next_section_index = ?,
           segments_json = ?, audio_storage_path = ?, current_section = ?,
           total_sections = ?, warning = ?, error_message = ?,
           processing_lease_token = NULL,
           lease_expires_at = NULL, processing_started_at = NULL,
           updated_at = unixepoch()`;
      const readyArgs = [
        publishedStatus,
        complete ? 100 : Math.min(99, Math.round((doneCount / total) * 100)),
        total,
        JSON.stringify(segments),
        playable ? path : null,
        doneCount,
        total,
        playable ? warning : UNJOINED_BOOK_WARNING,
        failureMessage,
      ];
      try {
        await writeWithLease(
          jobId,
          lease,
          `${readySql}
         WHERE id = ? AND processing_lease_token = ?`,
          readyArgs
        );
      } catch (err) {
        if (!(err instanceof LeaseLostError)) throw err;
        // The full file is already in storage. A lease that expired during
        // a long finalize must not leave the job failed, and must not be
        // required to publish the file we just uploaded. A deleted row is
        // included here: publishing it would resurrect a job the user removed.
        const published = await execute(
          `${readySql}
           WHERE id = ? AND status != 'cancelled' AND deleted_at IS NULL`,
          [...readyArgs, jobId]
        );
        if (published.rowsAffected === 0) {
          const row = await queryOne<{
            status: string;
            deleted_at: number | null;
          }>(`SELECT status, deleted_at FROM jobs WHERE id = ?`, [jobId]);
          if (row && (row.deleted_at != null || row.status === "cancelled")) {
            publishRefused = true;
          }
          throw err;
        }
      }
      markedReady = true;
      console.log(
        complete
          ? `[Job ${jobId}] full file uploaded — marking ready`
          : `[Job ${jobId}] only ${doneCount}/${total} sections exist — marking FAILED, ` +
              `not a complete audiobook (${total - doneCount} missing)`
      );
    };
    // A whole-book concat can outlive the wave by many minutes. Keep the
    // heartbeat renewing for as long as it runs, or the sweeper reclaims the
    // job mid-finalize.
    const concatHold = await holdBookConcat(jobId);
    if (concatHold.kind === "unavailable") {
      await stopBook(jobId, lease, MODAL_WORKSPACE_DISABLED_MESSAGE, null);
      return { done: true, nextIndex: total, total };
    }
    if (concatHold.kind === "failed") {
      await failJob(
        jobId,
        lease,
        "Could not assemble the full audiobook — remux failed"
      );
      return { done: true, nextIndex, total };
    }
    if (concatHold.kind === "deferred") throw new CpuBacklogError();
    const finalizing = markJobFinalizing(jobId);
    try {
      if (concatHold.kind === "already") {
        audioPath = concatHold.path;
        uploadedPath = concatHold.path;
        await markReady(concatHold.path);
      } else {
        try {
          audioPath = await runInsideCpuTask(() =>
            materializeFullAudiobook(jobId, segments, total, {
              crossfadeMs:
                typeof ttsOptions.crossfadeMs === "number"
                  ? ttsOptions.crossfadeMs
                  : undefined,
              allowHoles: holesLeft > 0,
              joinKinds: packed.map((s) => s.joinKind ?? "paragraph"),
              onDryUploaded: async (path) => {
                uploadedPath = path;
                await markReady(path);
              },
            })
          );
          await concatHold.finish(Boolean(audioPath));
        } catch (err) {
          await concatHold.finish(false);
          throw err;
        } finally {
          await concatHold.release();
        }
      }
    } catch (err) {
      console.error(`[Job ${jobId}] failed to materialize full audiobook:`, err);
    } finally {
      finalizing.end();
    }
    // A delete or cancel can land while materialize runs. The lease write
    // above sees a lost token, but a row that was already deleted is worth a
    // direct read so its uploaded file can be removed.
    if (!markedReady) {
      const afterFinalize = await queryOne<{
        status: string;
        deleted_at: number | null;
      }>(`SELECT status, deleted_at FROM jobs WHERE id = ?`, [jobId]);
      if (
        afterFinalize &&
        (afterFinalize.deleted_at != null || afterFinalize.status === "cancelled")
      ) {
        publishRefused = true;
      }
    }
    const removeUploadedFullFile = async () => {
      const orphan = uploadedPath ?? audioPath;
      if (!orphan) return;
      await deleteFile(orphan).catch((err) => {
        console.warn(
          `[Job ${jobId}] failed to remove full file for a removed job ${orphan}:`,
          err
        );
      });
    };
    if (publishRefused) {
      await removeUploadedFullFile();
      console.log(`[Job ${jobId}] job was deleted or cancelled mid-finalize`);
      return { done: true, nextIndex: total, total };
    }
    if (!markedReady && uploadedPath) {
      try {
        await markReady(uploadedPath);
      } catch (err) {
        console.error(`[Job ${jobId}] uploaded but not marked ready:`, err);
      }
    }
    // A zip from the concat fallback is refused by markReady, so the job has
    // no playable file and must fail instead of sitting in processing.
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
      firstError ? userFriendlyError(firstError) : "No audio was produced"
    );
    return { done: true, nextIndex, total };
  }

  await writeWithLease(
    jobId,
    lease,
    `UPDATE jobs SET status = 'queued', next_section_index = ?, progress = ?,
       current_section = ?, processing_lease_token = NULL,
       lease_expires_at = NULL, processing_started_at = NULL,
       sched_not_before = NULL,
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

const STORED_GOOGLE_STOPPED =
  "This narrator is no longer available. Audio already saved for this book is unchanged.";

/**
 * A stored Google / Randolph book is not spoken again and its files stay put.
 * A finished file is marked ready. An unfinished one stops so the worker
 * does not keep claiming it.
 */
async function parkStoredGoogleJob(
  job: StockJobRow,
  lease: string
): Promise<{ done: boolean; nextIndex: number; total: number }> {
  const segments = parseSegments(job.segments_json);
  const total = job.total_sections ?? segments.length;
  const fullFile = Boolean(
    job.audio_storage_path && !isSectionStoragePath(job.audio_storage_path)
  );
  const complete = fullFile || (total > 0 && allIndexesReady(segments, total));
  if (complete) {
    await writeWithLease(
      job.id,
      lease,
      `UPDATE jobs SET status = 'ready', error_message = NULL,
         processing_lease_token = NULL, lease_expires_at = NULL,
         processing_started_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND processing_lease_token = ?`,
      []
    );
    return {
      done: true,
      nextIndex: job.next_section_index ?? total,
      total,
    };
  }
  await writeWithLease(
    job.id,
    lease,
    `UPDATE jobs SET status = 'failed', error_message = ?,
       processing_lease_token = NULL, lease_expires_at = NULL,
       processing_started_at = NULL, updated_at = unixepoch()
     WHERE id = ? AND processing_lease_token = ?`,
    [STORED_GOOGLE_STOPPED]
  );
  return {
    done: true,
    nextIndex: job.next_section_index ?? 0,
    total,
  };
}

/**
 * Terminal stop that does not rewrite section audio, `provider_pin`,
 * or `audio_storage_path`. `progress` is left as it was when null.
 */
async function stopBook(
  jobId: string,
  lease: string,
  message: string,
  progress: number | null
): Promise<void> {
  console.error(`[Job ${jobId}] ${message}`);
  const progressSql = progress == null ? "" : ", progress = ?";
  const args =
    progress == null
      ? [message, jobId, lease]
      : [message, progress, jobId, lease];
  await execute(
    `UPDATE jobs SET status = 'failed', error_message = ?, warning = NULL${progressSql},
       processing_lease_token = NULL, lease_expires_at = NULL,
       processing_started_at = NULL, sched_not_before = NULL,
       updated_at = unixepoch()
     WHERE id = ? AND status NOT IN ('ready', 'cancelled')
       AND (processing_lease_token IS NULL OR processing_lease_token = ?)`,
    args
  );
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
  // The lease write misses when the token was already cleared. Record the
  // failure only if nobody has published the book or taken the job over.
  // An unconditional update used to mark a finished upload as failed.
  await execute(
    `UPDATE jobs SET status = 'failed', error_message = ?, updated_at = unixepoch()
     WHERE id = ? AND status NOT IN ('ready', 'cancelled')
       AND (processing_lease_token IS NULL OR processing_lease_token = ?)`,
    [message, jobId, lease]
  );
}

interface SynthesisSuccess {
  ok: true;
  audio: Buffer;
  contentType: string;
  extension: string;
  durationHintSeconds?: number;
  cacheKey?: string;
  /** Whisper could not run. The raw take is stored; the section is not ready. */
  qaDeferred?: boolean;
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

async function synthesizeChecked(
  args: {
    jobId: string;
    index: number;
    sectionText: string;
    frozen?: FrozenSection;
    provider: ReturnType<typeof resolveStockAdapter>;
    voiceId: string;
    catalog: Awaited<ReturnType<typeof getCatalogVoice>>;
    modelSlug?: string;
    ttsOptions: TtsOptions;
    clonePin?: CloneProviderChoice | null;
    squeakGuard?: SqueakGuardContext | null;
    /** First-light section 0. The transcript check waits; playback does not. */
    skipSectionQa?: boolean;
  },
  rate: SpeechRate
): Promise<SynthesisFailure | SynthesisSuccess> {
  const { squeakGuard, ...sectionArgs } = args;
  const checked = await synthesizeSettled(sectionArgs, rate);
  if (!checked.ok || !squeakGuard) return checked;
  const guarded = await guardSectionSqueaks({
    jobId: args.jobId,
    index: args.index,
    take: {
      audio: checked.audio,
      contentType: checked.contentType,
      durationHintSeconds: checked.durationHintSeconds,
    },
    ctx: squeakGuard,
    regenerate: async () => {
      const again = await synthesizeSection({ ...sectionArgs, useCache: false });
      return again.ok
        ? {
            audio: again.audio,
            contentType: again.contentType,
            durationHintSeconds: again.durationHintSeconds,
          }
        : null;
    },
  });
  if (guarded.regenerated && checked.cacheKey) {
    await writeSectionCache(
      checked.cacheKey,
      extensionForContentType(guarded.rawContentType),
      guarded.rawAudio,
      guarded.rawContentType
    );
  }
  return {
    ...checked,
    audio: guarded.audio,
    contentType: guarded.contentType,
    extension: extensionForContentType(guarded.contentType),
    durationHintSeconds: guarded.durationHintSeconds,
  };
}

async function synthesizeSettled(
  args: {
    jobId: string;
    index: number;
    sectionText: string;
    frozen?: FrozenSection;
    provider: ReturnType<typeof resolveStockAdapter>;
    voiceId: string;
    catalog: Awaited<ReturnType<typeof getCatalogVoice>>;
    modelSlug?: string;
    ttsOptions: TtsOptions;
    clonePin?: CloneProviderChoice | null;
    skipSectionQa?: boolean;
  },
  rate: SpeechRate
): Promise<SynthesisFailure | SynthesisSuccess> {
  const first = await synthesizeSection(args);
  if (!first.ok) return first;
  if (args.skipSectionQa) {
    console.log(
      `[Job ${args.jobId}] section ${args.index} published before transcript QA`
    );
    return first;
  }
  let settled: Awaited<ReturnType<typeof settleSectionTake>>;
  try {
    settled = await settleSectionTake({
      jobId: args.jobId,
      index: args.index,
      sourceText: args.sectionText,
      first,
      rate,
      regenerationBudgetMs: qaRegenerationBudgetMs(sectionAttemptBudgetMs(args.provider.id, args.sectionText)),
      synthesize: async (text, remainingMs) => {
        const again = await synthesizeSection({
          ...args,
          sectionText: text,
          frozen: undefined,
          useCache: false,
          maxAttempts: 1,
          deadlineMs: Date.now() + remainingMs,
        });
        return again.ok ? { audio: again.audio, contentType: again.contentType } : null;
      },
    });
  } catch (err) {
    if (err instanceof CpuSaturatedError) {
      return { ...first, qaDeferred: true };
    }
    throw err;
  }
  if (settled.audio !== first.audio && first.cacheKey) {
    await writeSectionCache(
      first.cacheKey,
      extensionForContentType(settled.contentType),
      settled.audio,
      settled.contentType
    );
  }
  return {
    ...first,
    audio: settled.audio,
    contentType: settled.contentType,
    extension: extensionForContentType(settled.contentType),
    durationHintSeconds: settled.durationSec ?? first.durationHintSeconds,
  };
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
  /** Engine this book is pinned to, when it has a clone voice. */
  clonePin?: CloneProviderChoice | null;
  useCache?: boolean;
  maxAttempts?: number;
  deadlineMs?: number;
}): Promise<SynthesisFailure | SynthesisSuccess> {
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

  for (let attempt = 0; attempt < (args.maxAttempts ?? SECTION_ATTEMPTS); attempt++) {
    if (args.deadlineMs != null && Date.now() >= args.deadlineMs) break;
    if (attempt > 0) {
      // A rejected request will be rejected again; only retry transient faults.
      if (/40[0134]|invalid|bad request/i.test(lastError)) break;
      const nextBudget = sectionAttemptBudgetMs(args.provider.id, synthText);
      const gap = coverLeaseUntil(
        args.jobId,
        Date.now() + RETRY_BACKOFF_MS * attempt + nextBudget
      );
      try {
        if (RETRY_BACKOFF_MS > 0) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
        }
      } finally {
        gap.end();
      }
    }

    // Retries fall back to undirected text — aggressive steering is a known
    // trigger for empty Gemini audio. Silent takes stay at Fish `normal`.
    const useDirection = supportsDirection && attempt === 0;
    // Paradee takes speed in its own 1.0-native units, not Fish prosody.
    const speed =
      args.provider.id === "paradee"
        ? undefined
        : fishSpeedForRequest(ttsOptions.narrationSpeed);
    const cacheKey = takehomeSectionCacheKey({
      text: args.frozen?.text ?? sectionText,
      voiceId: args.voiceId,
      model: modelId,
      index: args.index,
      attempt,
      speed,
      providerId: args.provider.id,
      catalogVoiceId: args.catalog?.id,
    });
    const cacheEnabled =
      args.useCache !== false &&
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

      // Per provider. Fish at 10 chars/s plus 60s covers a 9,200-character
      // section (real jobs run near 37 chars/s). Edge uses its stream cap.
      // The signal is created inside the closure, after withFishSlot
      // acquires the account slot, so queue time is not on the clock.
      // Google Cloud TTS is not synthesized.
      const budgetMs = sectionAttemptBudgetMs(args.provider.id, synthText);
      const queuedMs =
        args.provider.id === "fish"
          ? Math.max(budgetMs, fishAttemptBudgetMs(FISH_HARD_MAX_CHARS))
          : budgetMs;
      const cover = coverLeaseUntil(args.jobId, Math.min(Date.now() + queuedMs, args.deadlineMs ?? Infinity));
      try {
        const synthesize = () => {
          const remainingMs = args.deadlineMs == null ? budgetMs : Math.min(budgetMs, args.deadlineMs - Date.now());
          if (remainingMs <= 0) throw new Error("qa regeneration budget");
          const signal = AbortSignal.timeout(remainingMs);
          cover.until(Date.now() + remainingMs);
          return args.provider.synthesize({
            text: useDirection
              ? geminiDirectedInput(synthText, accent)
              : synthText,
            voiceId: args.voiceId,
            catalogVoiceId: catalog?.id,
            jobId: args.jobId,
            sectionIndex: args.index,
            language: catalog?.locale,
            model: modelSlug,
            latency: takehomeCacheLatency(args.index, attempt),
            chunkLength: TAKEHOME_FISH_CHUNK_LENGTH,
            speed,
            signal,
            // Once the engine is pinned, a failure must be visible instead of
            // silently switching narrator. `seedEpoch` makes a retry a
            // different take, so a duplicate attempt is not billed twice for
            // identical audio.
            cloneProviderPin: args.clonePin ?? null,
            allowFallback: !args.clonePin,
            seedEpoch: attempt,
            stylePrompt:
              supportsDirection || !supportsStyle || attempt > 0
                ? undefined
                : resolveStylePrompt({
                    catalogStylePrompt: catalog?.stylePrompt,
                    ttsOptionsStylePrompt: ttsOptions.stylePrompt,
                    locale: catalog?.locale,
                  }),
          });
        };
        // Fish account calls share the account slot. A pinned Modal section
        // does not: that HTTP is a clone lane, and taking a Fish permit for
        // it would block a Fish book without capping the GPU. The lane
        // dispatcher holds the Modal permit. This fallback does not.
        const result =
          args.provider.id === "fish" && args.clonePin !== "modal"
            ? await withFishSlot(synthesize)
            : await synthesize();

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
          cacheKey,
        };
      } catch (err) {
        if (err instanceof ProviderSlotBusyError) throw err;
        if (err instanceof FishRateLimitError) {
          lastError = err.message;
          console.warn(
            `[Job ${args.jobId}] section ${args.index} 429 — waiting ${err.retryAfterMs}ms`
          );
          cover.until(Date.now() + err.retryAfterMs + budgetMs);
          await new Promise((r) => setTimeout(r, err.retryAfterMs));
          continue;
        }
        if (err instanceof ModalCloneColdError) {
          // The pool is empty, not broken. Stop retrying this section in this
          // tick: every attempt would open another container that is still
          // restoring, and the book is parked by the caller.
          return { ok: false, error: err.message, cold: true };
        }
        if (err instanceof ModalWorkspaceDisabledError) {
          throw err;
        }
        if (err instanceof ModalCloneProviderError) {
          // Modal answered, and the answer was an error (`job 5f09ee0e`: the
          // reference decoder raised TypeError and every lane returned 500).
          // Retrying the same request cannot fix that, and it is *not* a cold
          // placement, so it must not park the book on the cold clock. Hand the
          // provider's message up so the tick follows the existing defer →
          // fallback path and the book is not failed with a spent retry.
          lastError = err.message;
          console.error(
            `[Job ${args.jobId}] section ${args.index} Modal provider fault: ${lastError}`
          );
          return { ok: false, error: lastError, providerFault: true };
        }
        if (err instanceof ModalCloneReferenceError) {
          // A bad sample or empty transcript will fail the same way forever.
          lastError = err.message;
          console.error(
            `[Job ${args.jobId}] section ${args.index} unusable clone reference: ${lastError}`
          );
          return { ok: false, error: lastError, fatal: true };
        }
        lastError = err instanceof Error ? err.message : String(err);
        if (
          isUpstreamThrottle(lastError) &&
          isEdgeOrGoogleProvider(args.provider.id)
        ) {
          const next = noteEdgeGoogleThrottle();
          console.warn(
            `[Job ${args.jobId}] section ${args.index} throttled — in flight ${next}`
          );
        }
        console.error(
          `[Job ${args.jobId}] section ${args.index} attempt ${attempt + 1} failed:`,
          lastError
        );
      } finally {
        cover.end();
      }
    } catch (err) {
      if (err instanceof ProviderSlotBusyError) throw err;
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
 *
 * `changed` says whether the row may have moved, so a poller knows if its
 * copy is stale. A tick that only found another worker holding the lease
 * leaves the row as it was.
 */
export async function runTakehomeWave(
  jobId: string,
  budgetMs = Number(process.env.TTS_WORKER_WAVE_BUDGET_MS || "240000")
): Promise<{ deferred: boolean; changed: boolean; yieldSlot?: boolean }> {
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
      if (result.yieldSlot) {
        console.log(
          `[Job ${jobId}] yielding the slot while cpu or provider capacity is busy`
        );
        return { deferred: false, changed: true, yieldSlot: true };
      }
      if (result.deferred) {
        console.log(
          `[Job ${jobId}] deferred until a later wave (text or listen-prep not ready)`
        );
        return { deferred: true, changed: true };
      }
      if (result.busy) {
        console.log(`[Job ${jobId}] another worker holds the lease`);
        return { deferred: false, changed: false };
      }
      if (result.done) {
        console.log(`[Job ${jobId}] finished after ${ticks} tick(s)`);
        return { deferred: false, changed: true };
      }
      console.log(
        `[Job ${jobId}] tick ${ticks}: next=${result.nextIndex}/${result.total}`
      );
    } catch (err) {
      console.error(`[Job ${jobId}] tick ${ticks} failed:`, err);
      return { deferred: false, changed: false };
    }
  }

  console.warn(
    `[Job ${jobId}] wave paused after ${ticks} tick(s) with work remaining`
  );
  return { deferred: false, changed: ticks > 0 };
}

/**
 * Another take-home that can actually run. A `waiting` job counts when its
 * upload is already `ready` or `failed` — the default create-while-reading
 * path stays `waiting` until a worker claims it, and this run holds the
 * only slot. A file that is still being read does not take the turn.
 * `listDrainableTakehomeJobs` and `claimTakehomeLease` already include
 * `waiting`, so the next drain picks that book up.
 */
async function hasOtherRunnableTakehome(jobId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM jobs
     WHERE deleted_at IS NULL
       AND job_kind = 'takehome'
       AND id != ?
       AND (
         status = 'queued'
         OR (
           status = 'processing'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= unixepoch()
         )
         OR (
           status = 'waiting'
           AND EXISTS (
             SELECT 1 FROM uploads u
             WHERE u.storage_path = jobs.pdf_storage_path
               AND u.status IN ('ready', 'failed')
           )
         )
       )
     LIMIT 1`,
    [jobId]
  );
  return Boolean(row);
}

/**
 * VM / Trigger host: keep waving until the job settles. Long budget
 * (minutes), not the poll-nudge cap. Stops on ready / failed / cancelled
 * / lease loss. After each wave, if someone else is queued, the lease is
 * already back on `queued` (the tick releases it) and this run returns so
 * the drain can pick the oldest runnable job, including one still marked
 * `waiting` whose file is already read or failed. A book that is only
 * waiting on CPU returns `yielded` so another book can use the slot.
 * Local ffmpeg stays one slot unless `WORKER_LOCAL_MULTIBOOK=1`.
 */
export async function runTakehomeUntilSettled(
  jobId: string,
  budgetMs = DEFAULT_TRIGGER_WAVE_BUDGET_MS
): Promise<{ status: string }> {
  const maxWaves = Number(process.env.TTS_MAX_WAVES_PER_RUN || "80");
  for (let n = 0; n < maxWaves; n++) {
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
      const outcome = await runTakehomeWave(jobId, budgetMs);
      // The book's text is not extracted yet. Hot-looping waves here would
      // hammer the row for nothing — hand it back to the drain cadence.
      if (outcome.deferred) return { status: "deferred" };
      // CPU or a provider cap is busy. The lease is already released and
      // the book is not eligible again until sched_not_before, so the
      // drain can run someone else on this slot.
      if (outcome.yieldSlot) return { status: "yielded" };
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

    if (await hasOtherRunnableTakehome(jobId)) {
      await releaseHeldTakehomeIfAny(jobId);
      console.log(
        `[Job ${jobId}] yielding after wave ${n + 1} so another take-home can run`
      );
      return { status: "yielded" };
    }
  }

  return { status: "queued" };
}

/** The tick normally clears the token. This covers a wave that still holds it. */
async function releaseHeldTakehomeIfAny(jobId: string): Promise<void> {
  const token = inFlightTakehomeLeases.get(jobId);
  if (!token) return;
  await releaseLease(jobId, token, { status: "queued" });
  dropInFlightTakehomeLease(jobId, token);
}

/**
 * Return jobs whose worker died mid-flight (lease expired without a heartbeat)
 * to the queue. Cheap enough for UI poll paths to call.
 */
export async function releaseExpiredTakehomeLeases(): Promise<number> {
  try {
    await requeueExpiredCpuTasks().catch((err) => {
      console.error("[cpu] expired task sweep failed:", err);
    });
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
  const claim = takehomeClaimSql(takehomeInflightCap());
  const rows = await query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE deleted_at IS NULL
       AND job_kind = 'takehome'
       AND status IN ('queued', 'waiting')${claim.filter}${claim.order}
     LIMIT ?`,
    [...claim.args, limit]
  );
  return rows.map((r) => r.id);
}

/**
 * VM drain: queued take-homes, jobs parked `waiting` for extract, and
 * processing rows whose lease expired. The deployed Trigger drain does not
 * have this `waiting` clause — that is what keeps a parked book off it.
 * Deduped by job id.
 */
export async function listDrainableTakehomeJobs(limit = 50): Promise<string[]> {
  const claim = takehomeClaimSql(takehomeInflightCap());
  const rows = await query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE deleted_at IS NULL
       AND job_kind = 'takehome'
       AND (
         status = 'queued'
         OR status = 'waiting'
         OR (
           status = 'processing'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= unixepoch()
         )
       )${claim.filter}${claim.order}
     LIMIT ?`,
    [...claim.args, limit]
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

/**
 * How often one isolate may sweep expired leases from a player poll. The sweep
 * writes to `jobs`, so running it on every viewer poll was a write
 * amplification problem; the worker's own drain covers the gap.
 */
const POLL_SWEEP_INTERVAL_MS = 30_000;
let lastPollSweepAt = 0;

/** Tests need a fresh throttle window between cases. */
export function resetPollSweepThrottle(): void {
  lastPollSweepAt = 0;
}

function pollSweepDue(now = Date.now()): boolean {
  if (lastPollSweepAt !== 0 && now - lastPollSweepAt < POLL_SWEEP_INTERVAL_MS) {
    return false;
  }
  lastPollSweepAt = now;
  return true;
}

/**
 * Same as {@link nudgeStaleTakehomeJobs}, scoped to one job the user is watching.
 * Returns whether anything could have moved, so a poller knows when its copy
 * of the row is stale. With the default read-only budget this touches no rows.
 */
export async function nudgeStaleTakehomeJobIfNeeded(job: {
  id: string;
  job_kind?: string | null;
  status: string;
  updated_at: number;
}): Promise<boolean> {
  if (job.job_kind !== "takehome") return false;
  if (job.status === "ready" || job.status === "failed") return false;

  const budgetMs = pollNudgeBudgetMs();
  if (budgetMs <= 0) return false;
  try {
    const released = pollSweepDue() ? await releaseExpiredTakehomeLeases() : 0;
    // Only this row being `processing` says the release touched the job the
    // caller holds; another job's abandoned lease is not this poll's news.
    const releasedThisJob = released > 0 && job.status === "processing";
    const wave = await runTakehomeWave(job.id, budgetMs);
    return releasedThisJob || wave.changed;
  } catch (err) {
    console.error(`[Job ${job.id}] nudge failed:`, err);
    return false;
  }
}
