/**
 * Self-hosted S2-Pro clone synthesis on Modal — the DEFAULT clone path.
 *
 * Any cloned voice goes through here once `MODAL_S2_TTS_URL` and
 * `MODAL_S2_TOKEN` are set. Drama 3 (OpenRouter) remains the fallback, then
 * direct Fish, but only at a boundary the worker chose deliberately — see
 * below.
 *
 * `CLONE_TTS_PROVIDER`:
 *   unset / "modal"  -> this path (default)
 *   "openrouter"     -> Drama 3 only, for rollback
 *   "fish"           -> direct Fish only
 *
 * ## Cold starts are normal, not a failure
 *
 * The pool scales to zero. A book may wait for a snapshot *restore* (~30–90 s,
 * `MODAL_S2_COLD_WAIT_MS`, hard ceiling 180 s). It must not wait for a compile
 * (8–16 min). A placement that is still cold at that budget throws
 * {@link ModalCloneColdError} with `scope: "placement"`: the HTTP wait is
 * dropped. A gateway miss (502/503/504) may be tried once on another
 * container. A client timeout is different: the sync handler keeps rendering,
 * so those sections are not posted again in the same dispatch, and the 30s
 * backoff is this book only. An off-path RPC warm is kicked so that worker
 * variant can finish its snapshot. HTTP cannot — the proxy dies at ~542 s
 * and leaves nothing. There is no Modal-side cancel in this process.
 * A probe that says the pool is empty is `scope: "pool"` and does not open
 * more calls. The worker parks the book and, only after `MODAL_S2_DEFER_MS`,
 * switches engine.
 *
 * Falling through to another engine mid-book is what produced two narrators in
 * one audiobook, so it only happens when the worker has run out of defer
 * budget, and it writes a job warning when it does.
 *
 * ## Idempotency
 *
 * Every call is a pure function of (job, section keys, retry epoch). The seed
 * travels with the request, so a retried batch renders the same takes rather
 * than billing a second, different one. A section that is already stored is
 * never re-claimed, and the section cache is keyed by text + voice so a
 * duplicate call is served from R2 instead of the GPU.
 *
 * The container returns a mastered MP3 for the whole section. It applies the
 * spectral chain from `MODAL_S2_MASTERING`; the app's `prepareSectionForStorage`
 * still owns loudness, so a section is normalised exactly once.
 *
 * The container needs the reference transcript: Fish's prompt format drops a
 * reference that has no text. `cloned_voices.reference_transcript` is filled at
 * clone time; older rows fall back to the container's Whisper.
 *
 * Batch rows use `audio_b64` (the server name). `audio_base64` is still read
 * so an older fixture keeps working. A row with neither an error nor decodable
 * MP3 fails the call instead of staging zero sections.
 */
import { createHash } from "crypto";
import type { SynthesizeInput } from "@/lib/tts/types";
import { sniffAudioContentType } from "@/lib/tts/pcm-wav";
import {
  modalPlatformRefusal,
  redactModalAccount,
} from "@/lib/modal/workspace-disabled";
import { MODAL_S2_SAMPLING } from "@/lib/tts/providers/s2-sampling";
import {
  cloneTakeIsTruncated,
  modalCloneBatchItems,
  modalCloneCallTimeoutMs,
  modalCloneMixedBookBatchEnabled,
  modalCloneLanes,
  modalCloneReadyProbeEnabled,
  modalCloneReadyTimeoutMs,
  modalCloneRetryDelayMs,
  recordModalCloneUsage,
  resetModalCloneGuardForTests,
} from "@/lib/tts/providers/modal-clone-guard";
import {
  clonePoolStillWarm,
  MODAL_CLONE_RESPONSE_BODY_MAX_BYTES,
  modalCloneArmedWaitMs,
} from "@/lib/tts/providers/modal-clone-lanes";
import {
  kickModalCloneSnapshotWarm,
  resetModalCloneWarmForTests,
} from "@/lib/tts/providers/modal-clone-warm";
import {
  holdModalCloneLaneSlot,
  ProviderSlotBusyError,
} from "@/lib/tts/provider-slots";

/** Matches the clone reference cap enforced at upload. */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
/** After a cold probe or a timed-out call, skip Modal for this long. */
const COLD_BACKOFF_MS = 30_000;

/**
 * `pool` — nothing warm is serving, or this process is in the short backoff.
 * Do not open another HTTP call.
 * `placement` — this container did not answer inside the restore budget. Another
 * lane may land on a variant that already has a snapshot. The compile, if that
 * is what this was, is finished by the off-path RPC, not by waiting here.
 */
export type ModalCloneColdScope = "pool" | "placement";

/**
 * The pool had nothing warm, or one placement missed the restore budget.
 * Not a broken book: the worker defers, then falls back when the defer budget
 * is spent.
 */
export class ModalCloneColdError extends Error {
  readonly retryAfterMs: number;
  readonly scope: ModalCloneColdScope;
  /**
   * Which clock expired. `warm` is a container that had already answered,
   * so it must not kick a snapshot compile. `restore` may.
   */
  readonly waitKind?: "restore" | "steady" | "warm";
  /**
   * The worker dropped the HTTP wait (`TimeoutError` / `AbortError`).
   * The sync Modal handler keeps rendering that input. A second POST of
   * the same sections is another container (`max_inputs=1` does not
   * answer 429) and bills the text twice, so dispatch must not send
   * them again in this wave.
   */
  readonly clientAborted: boolean;
  constructor(
    message = "Modal clone pool is cold",
    retryAfterMs = COLD_BACKOFF_MS,
    scope: ModalCloneColdScope = "pool",
    waitKind?: "restore" | "steady" | "warm",
    clientAborted = false
  ) {
    super(message);
    this.name = "ModalCloneColdError";
    this.retryAfterMs = retryAfterMs;
    this.scope = scope;
    this.waitKind = waitKind;
    this.clientAborted = clientAborted;
  }
}

/** The reference sample or transcript cannot prompt a clone. Not retryable. */
export class ModalCloneReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalCloneReferenceError";
  }
}

/**
 * The container answered 429: its lane is already rendering.
 *
 * The deployed class is `@modal.concurrent(max_inputs=1)`, so Modal places
 * a second input on another container instead of returning 429. This error
 * stays as the backstop for a container that still answers `lane_busy`.
 * It is busy, not cold, and must not start a cold backoff.
 */
export class ModalCloneLaneBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalCloneLaneBusyError";
  }
}

/**
 * The container answered with a hard provider fault (a 5xx that is not a
 * gateway timeout, or a body that is not usable MP3).
 *
 * Distinct from {@link ModalCloneColdError} on purpose. The 2026-11-06
 * `job 5f09ee0e` book failed with "Modal clone already retried" because a bare
 * HTTP 500 — `TypeError: open() got an unexpected keyword argument
 * 'metadata_errors'` from the reference decoder — was retried like a
 * transient blip. Each retry spent an attempt, so the per-section path burned
 * the ledger and surfaced that misleading status instead of the real fault.
 *
 * A hard fault is retried at most once (a genuinely flaky container is worth
 * one more try) and then surfaces the provider's own message.
 */
export class ModalCloneProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ModalCloneProviderError";
    this.status = status;
  }
}

/** Retries a hard provider fault gets before its message is surfaced. */
export const MODAL_CLONE_PROVIDER_TRIES = 1;

interface AttemptState {
  /** Calls that produced a take (or a hard fault) for this section. */
  count: number;
  /** How many of those were hard provider faults. */
  hardFaults: number;
  /** The provider's own message, kept so the ledger is never the final error. */
  lastError: string | null;
}

const EMPTY_ATTEMPT: AttemptState = { count: 0, hardFaults: 0, lastError: null };

const attempts = new Map<string, AttemptState>();
/** App-wide backoff. Set only when the pool itself is empty. */
let poolColdUntil = 0;
/** Per-book backoff. One book's miss must not delay another book. */
const jobColdUntil = new Map<string, number>();
/**
 * When this process last got audio back from the one H100.
 * Lost on restart, which costs one cold-sized call and then fat batches again.
 * Not a database column: a worker restart must not write production rows.
 */
let poolAnsweredAt: number | null = null;
/** When this book last got audio back from its own container. */
const bookAnsweredAt = new Map<string, number>();

export function resetModalCloneRuntimeForTests(): void {
  attempts.clear();
  poolColdUntil = 0;
  jobColdUntil.clear();
  poolAnsweredAt = null;
  bookAnsweredAt.clear();
  resetModalCloneGuardForTests();
  resetModalCloneWarmForTests();
}

export function noteModalClonePoolAnswered(
  now: number = Date.now(),
  jobId?: string
): void {
  poolAnsweredAt = now;
  if (!jobId) return;
  bookAnsweredAt.set(jobId, now);
  if (bookAnsweredAt.size > 4_000) {
    const oldest = bookAnsweredAt.keys().next().value;
    if (oldest) bookAnsweredAt.delete(oldest);
  }
}

export function noteModalClonePoolLost(): void {
  poolAnsweredAt = null;
}

function forgetModalCloneBookWarm(jobId: string): void {
  bookAnsweredAt.delete(jobId);
}

/**
 * True while this book has heard its own container inside the scaledown hold.
 * Another book's answer does not count: that container is busy with them,
 * and this book's call is placed on a container that still has to restore.
 */
export function modalCloneBookContainerWarm(
  jobId: string | undefined,
  now: number = Date.now()
): boolean {
  if (!jobId) return clonePoolStillWarm(now, poolAnsweredAt);
  return clonePoolStillWarm(now, bookAnsweredAt.get(jobId) ?? null);
}

/** True while the last successful answer is still inside the scaledown hold. */
export function modalClonePoolIsWarm(now: number = Date.now()): boolean {
  return clonePoolStillWarm(now, poolAnsweredAt);
}

/** Explicit provider choice, or "" when the default applies. */
function cloneProvider(): string {
  return process.env.CLONE_TTS_PROVIDER?.trim().toLowerCase() || "";
}

/**
 * True when a clone should be rendered here. Defaults to on, but only when
 * the endpoint is configured: without a URL there is nothing to call, and the
 * caller should fall through to Drama 3 rather than fail.
 */
export function usesModalClone(catalogVoiceId?: string | null): boolean {
  if (!Boolean(catalogVoiceId?.startsWith("clone:"))) return false;
  const provider = cloneProvider();
  if (provider && provider !== "modal") return false;
  return Boolean(process.env.MODAL_S2_TTS_URL?.trim());
}

/**
 * One Modal endpoint origin, validated.
 *
 * Each `@modal.fastapi_endpoint` is served at the root of **its own** hostname
 * (`https://…--app-synthesize-batch.modal.run`), so there is no shared path
 * prefix to append to. Building `${base}/synthesize_batch` 404s against a real
 * deploy even though a mocked fetch that fakes that exact path passes, which is
 * how the staging run found this.
 */
function endpointOrigin(raw: string | undefined, label: string): string {
  const text = (raw || "").trim();
  if (!text) throw new Error(`${label} is not configured`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be http(s), got ${url.protocol}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path) {
    throw new Error(
      `${label} must be a bare Modal endpoint host, but it has path "${url.pathname}". ` +
        `Every @modal.fastapi_endpoint is served at its own hostname root; configure one URL per endpoint.`
    );
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not carry a query or fragment`);
  }
  return url.origin;
}

/** The `synthesize_batch` endpoint. Required for any Modal clone call. */
export function modalBatchUrl(): string {
  return endpointOrigin(process.env.MODAL_S2_TTS_URL, "MODAL_S2_TTS_URL");
}

/**
 * The single-section `synthesize` endpoint, or null when none is configured.
 *
 * It is **not** derived from the batch host. `synthesize_batch` expects
 * `{ items: [...] }` and answers JSON; a single-section call posts `{ text,
 * reference_audio_base64, … }` and expects raw audio. Sending the second body
 * to the first host is a guaranteed 400 — and on 2026-11-06 that 400 arrived
 * only *after* a ~38 s GPU restore, because the container had to boot to
 * reject it. Production had the batch URL and no synthesize URL, so every
 * first preview paid a cold restore to earn a validation error.
 *
 * With no single host, {@link synthesizeModalClone} renders through the batch
 * endpoint with a one-row payload instead. That is correct everywhere,
 * including a deploy that only serves `/synthesize_batch`, and it reuses the
 * batch contract this project already verifies.
 */
export function modalSingleUrl(): string | null {
  const explicit = (process.env.MODAL_S2_SYNTHESIZE_URL || "").trim();
  return explicit
    ? endpointOrigin(explicit, "MODAL_S2_SYNTHESIZE_URL")
    : null;
}

/**
 * The `GET /ready` probe endpoint, or null when none is configured.
 *
 * Deliberately NOT derived from the batch URL: they are different hostnames, so
 * a derived value is a guaranteed 404. `MODAL_S2_READY=0` and an unset URL both
 * mean "no probe", and the call's own timeout decides instead.
 */
export function modalReadyUrl(): string | null {
  const explicit = (process.env.MODAL_S2_READY_URL || "").trim();
  if (!explicit) return null;
  const origin = endpointOrigin(explicit, "MODAL_S2_READY_URL");
  if (origin === modalBatchUrl()) {
    throw new Error(
      "MODAL_S2_READY_URL points at the synthesize host. The ready probe is a separate @modal.fastapi_endpoint with its own hostname."
    );
  }
  return origin;
}

/**
 * How many sections one HTTP call may carry.
 *
 * The container decodes all of them as separate rows of one batch, so GPU cost
 * is nearly flat in this number: measured 2.9x realtime on one section per
 * call, 55–65x when the batch is full. Keep it at or below the container's
 * `S2B_BATCH` (default 32); extra sections spill into a second call.
 */
export function modalCloneBatchSize(): number {
  return modalCloneBatchItems();
}

/** Concurrent batch calls for one book — i.e. GPU lanes to keep busy. */
export function modalCloneLaneCount(): number {
  return modalCloneLanes();
}

export interface CloneReference {
  audio: Buffer;
  transcript: string;
  userId: string;
  catalogVoiceId: string;
}

/**
 * Load and cache a clone's reference sample. Called once per book so each
 * batch call does not re-download it.
 */
export async function loadCloneReference(
  catalogVoiceId: string,
  voiceId: string
): Promise<CloneReference> {
  const { queryOne } = await import("@/lib/turso");
  const { downloadFile } = await import("@/lib/storage");
  const clone = await queryOne<{
    sample_storage_path: string | null;
    reference_transcript: string | null;
    user_id: string | null;
  }>(
    `SELECT sample_storage_path, reference_transcript, user_id FROM cloned_voices
     WHERE id = ? AND fish_voice_id = ? AND deleted_at IS NULL LIMIT 1`,
    [catalogVoiceId.slice("clone:".length), voiceId]
  );
  if (!clone?.sample_storage_path) {
    throw new ModalCloneReferenceError("Clone reference sample is unavailable");
  }
  const audio = await downloadFile(clone.sample_storage_path);
  if (!audio.length || audio.length > MAX_REFERENCE_BYTES) {
    throw new ModalCloneReferenceError(
      "Clone reference must be between 1 byte and 15 MiB"
    );
  }
  return {
    audio,
    transcript: clone.reference_transcript ?? "",
    userId: clone.user_id || "anonymous",
    catalogVoiceId,
  };
}

export interface CloneBatchItem {
  key: string;
  text: string;
  /**
   * Per-row reference. Sent only when `MODAL_S2_MIXED_BOOK_BATCH=1`.
   * The deployed container ignores these and uses the call-level reference,
   * so the tick does not set them.
   */
  referenceAudioBase64?: string;
  referenceText?: string;
  seed?: number;
}

type BatchRow = {
  key: string;
  audio_b64?: string;
  audio_base64?: string;
  duration_s?: number;
  truncated_units?: number;
  error?: string;
  error_code?: string;
};

type BatchResponse = {
  items?: BatchRow[];
  build?: string;
  container_id?: string;
  /** `restored` when this container provably resumed from a snapshot. */
  boot?: string;
  seed?: number;
  sampling?: string;
  reference?: { sha256?: string; seconds?: number | null; rms?: number | null };
  performance?: Record<string, unknown>;
};

/** What one batch call rendered, plus the container it came from. */
export interface CloneBatchOutcome {
  audio: Map<string, { audio: Buffer; durationSeconds: number }>;
  build: string | null;
  containerId: string | null;
  seed: number | null;
  performance: Record<string, unknown> | null;
  /**
   * `restored` when the container can prove it resumed from a snapshot,
   * `unknown` otherwise. A first-light call that took a long time and did not
   * report `restored` is a compile, which is what the off-path warm is for.
   */
  boot: string | null;
}

/**
 * Render many sections in one call. Returns audio keyed by the caller's key.
 *
 * A cold pool rejects with {@link ModalCloneColdError}; anything else rejects
 * as a whole and the caller decides whether the book can continue. Rows the
 * server marked truncated, or whose audio is far too short for the text, are
 * left out so the per-section path can retry once.
 */
export async function synthesizeModalCloneBatch(
  items: CloneBatchItem[],
  reference: CloneReference,
  signal?: AbortSignal,
  jobId?: string,
  opts?: { seedEpoch?: number }
): Promise<Map<string, { audio: Buffer; durationSeconds: number }>> {
  const outcome = await renderModalCloneBatch(items, reference, signal, jobId, opts);
  return outcome.audio;
}

export async function renderModalCloneBatch(
  items: CloneBatchItem[],
  reference: CloneReference,
  signal?: AbortSignal,
  jobId?: string,
  opts?: {
    seedEpoch?: number;
    raceForFirstAudio?: boolean;
    /** Narration seconds this pack is planned to need, for the call's wait. */
    workMs?: number;
    /**
     * The container already answered this process. Wait the warm budget and
     * do not treat a miss as a compile.
     */
    warmBatch?: boolean;
  }
): Promise<CloneBatchOutcome> {
  if (items.length === 0) {
    return {
      audio: new Map(),
      build: null,
      containerId: null,
      seed: null,
      performance: null,
      boot: null,
    };
  }
  const userId = reference.userId || "anonymous";
  const chars = items.reduce((sum, item) => sum + item.text.length, 0);
  // No allowance check: what may be generated is decided by the provider
  // account, not by a number this app invents. See `MODAL_CLONE_USAGE_ACTION`.
  const wait = await assertModalCloneReady(
    signal,
    opts?.raceForFirstAudio === true,
    opts?.workMs ?? 0,
    opts?.warmBatch === true,
    jobId
  );
  // Accounting only. It cannot refuse, and failing to record never blocks.
  await recordModalCloneUsage(userId, chars);

  const payload = await postJson(
    modalBatchUrl(),
    {
      items: items.map((item) => ({
        key: item.key,
        text: item.text,
        // The current container reads one reference for the call. These
        // fields are the redeployed contract; they are omitted until
        // MODAL_S2_MIXED_BOOK_BATCH=1, and the tick still does not mix books.
        ...(modalCloneMixedBookBatchEnabled() && item.referenceAudioBase64
          ? {
              reference_audio_base64: item.referenceAudioBase64,
              reference_text: item.referenceText ?? "",
              ...(item.seed != null ? { seed: item.seed } : {}),
            }
          : {}),
      })),
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: MODAL_S2_SAMPLING,
      ...(jobId ? { job_id: jobId } : {}),
      seed_epoch: Math.max(0, Math.floor(opts?.seedEpoch ?? 0)),
    },
    signal,
    wait
  );
  for (const item of items) {
    noteAttempt(attemptKey(reference.catalogVoiceId, item.text));
  }

  const body = payload as BatchResponse;
  const out = new Map<string, { audio: Buffer; durationSeconds: number }>();
  const undecodable: string[] = [];
  for (const row of body.items ?? []) {
    if (row.error) continue;
    const decoded = decodeBatchAudio(row);
    if (!decoded) {
      undecodable.push(String(row.key));
      continue;
    }
    const verdict = cloneTakeIsTruncated({
      text: items.find((item) => item.key === row.key)?.text ?? "",
      durationSeconds: Number(row.duration_s),
      truncatedUnits: Number(row.truncated_units) || 0,
    });
    if (verdict.truncated) continue;
    out.set(row.key, decoded);
    // The decoded buffer is what the next stage reads. Drop the base64
    // copy before the following call allocates another batch.
    row.audio_b64 = undefined;
    row.audio_base64 = undefined;
  }
  body.items = undefined;
  if (undecodable.length > 0) {
    throw new Error(
      `Modal clone batch returned ${undecodable.length} row(s) without decodable audio (${undecodable.join(",")})`
    );
  }
  if (out.size > 0) noteModalClonePoolAnswered(Date.now(), jobId);
  return {
    audio: out,
    build: body.build ?? null,
    containerId: body.container_id ?? null,
    seed: typeof body.seed === "number" ? body.seed : null,
    performance: body.performance ?? null,
    boot: typeof body.boot === "string" ? body.boot : null,
  };
}

/**
 * Synthesize one short line — a clone preview — inside a request budget.
 *
 * This is **not** the book path. A book is asynchronous and may park for a
 * snapshot restore; a preview is somebody waiting on a tap inside a serverless
 * function that Vercel kills at 60 s. So this refuses to open a cold-restore
 * wait at all:
 *
 *   1. the pool must be **provably warm** ({@link probeModalCloneWarm}); and
 *   2. even then the HTTP wait is the caller's budget, never
 *      `MODAL_S2_COLD_WAIT_MS`.
 *
 * When the pool is not warm it throws {@link ModalCloneColdError} with
 * `scope: "pool"` immediately (no fetch, no GPU time billed) and kicks a restore
 * so the next tap can be a storage read. That is the difference between the
 * 2026-11-06 behaviour — a 60 s Vercel timeout while a GPU restored and rendered
 * a take that was never stored — and a fast, honest "starting up".
 *
 * The same take is still rendered once and stored by the caller; this only
 * decides whether a preview may cost a synthesis at all.
 */
export async function synthesizeModalClonePreview(
  input: SynthesizeInput & { budgetMs?: number }
): Promise<{ audio: Buffer; contentType: string; durationHintSeconds?: number }> {
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  input.signal?.throwIfAborted();

  const probe = await probeModalCloneWarm(input.signal);
  if (!probe.warm) {
    // Nothing warm: do not spend a fetch, and leave a container warming.
    kickModalCloneSnapshotWarm(`preview needs a warm pool (${probe.reason})`);
    throw new ModalCloneColdError(
      `Modal clone pool is not warm (${probe.reason})`,
      COLD_BACKOFF_MS,
      "pool"
    );
  }

  const slot = await holdModalCloneLaneSlot(modalCloneLanes());
  if (!slot) throw new ProviderSlotBusyError("modal-clone");
  try {
  const reference = await loadCloneReference(input.catalogVoiceId!, input.voiceId);
  const budgetMs = Math.max(5_000, Math.floor(input.budgetMs ?? 45_000));
  const single = modalSingleUrl();
  const seedEpoch = Math.max(0, Math.floor(input.seedEpoch ?? 0));
  let audio: Buffer;
  let durationSeconds: number;
  if (single) {
    // The dedicated endpoint answers raw audio. It is only used when it is
    // actually configured: a single-section body posted at the batch host is a
    // guaranteed 400 (that mistake cost a cold restore on 2026-11-06).
    const response = await postModal(
      single,
      {
        text: input.text,
        reference_audio_base64: reference.audio.toString("base64"),
        reference_text: reference.transcript,
        sampling: MODAL_S2_SAMPLING,
        seed_epoch: seedEpoch,
      },
      input.signal,
      { ms: budgetMs, kind: "steady" }
    );
    audio = Buffer.from(await response.arrayBuffer());
    durationSeconds = Number(response.headers.get("x-s2-duration")) || 0;
  } else {
    const key = "preview";
    const payload = (await postJson(
      modalBatchUrl(),
      {
        items: [{ key, text: input.text }],
        reference_audio_base64: reference.audio.toString("base64"),
        reference_text: reference.transcript,
        sampling: MODAL_S2_SAMPLING,
        seed_epoch: seedEpoch,
      },
      input.signal,
      { ms: budgetMs, kind: "steady" }
    )) as BatchResponse;
    const rows = payload.items ?? [];
    const row = rows.find((item) => item.key === key) ?? rows[0];
    if (!row) {
      throw new ModalCloneProviderError("Modal clone returned no row for the preview");
    }
    if (row.error) {
      throw new ModalCloneProviderError(
        `Modal clone: ${row.error_code ? `${row.error_code}: ` : ""}${row.error}`
      );
    }
    const decoded = decodeBatchAudio(row);
    if (!decoded) {
      throw new ModalCloneProviderError(
        "Modal clone returned a row without decodable audio"
      );
    }
    audio = decoded.audio;
    durationSeconds = decoded.durationSeconds;
  }
  if (!audio.length || sniffAudioContentType(audio) !== "audio/mpeg") {
    throw new ModalCloneProviderError("Modal clone returned invalid MP3 audio");
  }
  noteModalClonePoolAnswered();
  return {
    audio,
    contentType: "audio/mpeg",
    ...(Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationHintSeconds: durationSeconds }
      : {}),
  };
  } finally {
    await slot.release();
  }
}

/**
 * Synthesize one section. Throws so the caller can defer the book on
 * {@link ModalCloneColdError}, or surface a real provider fault.
 *
 * There is no character allowance here. A section is attempted when the engine
 * is configured and a container is available; the provider account decides what
 * it will serve, and its auth/quota/billing errors surface as themselves.
 */
export async function synthesizeModalClone(
  input: SynthesizeInput & { seedEpoch?: number }
): Promise<{ audio: Buffer; contentType: string; durationHintSeconds?: number }> {
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  input.signal?.throwIfAborted();
  // One lane for this HTTP call. The book wave already holds one slot per
  // batch; this path is the per-section fallback, and it must not open the
  // other three slots `modalCloneLanes()` would allow. A full cap is a busy
  // lane, not a failed section and not a different voice.
  const slot = await holdModalCloneLaneSlot(1);
  if (!slot) throw new ProviderSlotBusyError("modal-clone");
  try {

  const reference = await loadCloneReference(input.catalogVoiceId!, input.voiceId);
  const userId = reference.userId;
  const catalogVoiceId = input.catalogVoiceId || input.voiceId;
  const wait = await assertModalCloneReady(
    input.signal,
    false,
    0,
    false,
    input.jobId
  );

  const key = attemptKey(catalogVoiceId, input.text);
  const state = attemptState(key);
  // A section that already ended in a hard provider fault gets one more take
  // (`MODAL_CLONE_PROVIDER_TRIES`); after that the provider's own message is
  // rethrown. A truncated-take retry keeps the older, stricter budget so a
  // genuinely short section cannot loop. The ledger is never the error text:
  // "Modal clone already retried" told an operator nothing about
  // `job 5f09ee0e` and hid the container's TypeError.
  const budget =
    state.hardFaults > 0 ? MODAL_CLONE_PROVIDER_TRIES + 1 : 2;
  if (state.count >= budget) {
    throw new ModalCloneProviderError(
      state.lastError ?? "Modal clone did not return usable audio"
    );
  }
  const tries = state.count >= 1 ? 1 : 2;
  let lastReason = "truncated";
  for (let i = 0; i < tries; i++) {
    input.signal?.throwIfAborted();
    const retry = state.count + i > 0;
    // Accounting only: records the characters this attempt will speak. It
    // cannot refuse and cannot fail the attempt.
    await recordModalCloneUsage(userId, input.text.length);
    let response: Awaited<ReturnType<typeof postSynthesize>>;
    try {
      response = await postSynthesize(
        input,
        reference,
        retry,
        // A retry must not replay the same take, so it moves the epoch.
        Math.max(0, Math.floor(input.seedEpoch ?? 0)) + (retry ? 1 : 0),
        wait
      );
    } catch (err) {
      // One section already spent the restore budget. The next section in this
      // process must not open another compile-length wait. Lane dispatch uses
      // the batch call, which does not set this, so it can still retry once.
      if (err instanceof ModalCloneColdError && err.scope === "placement") {
        // The next section of this book waits out the backoff. Another
        // book's ramp is a different key and is not held.
        rememberModalCloneCold(input.jobId);
      }
      // A hard fault is recorded so the next call surfaces it rather than
      // reporting a spent ledger. Cold and lane-busy are not the section's
      // fault and must not consume the budget.
      if (err instanceof ModalCloneProviderError) {
        noteAttempt(key, err.message, true);
      }
      throw err;
    }
    const duration = response.durationSeconds;
    const truncatedUnits = response.truncatedUnits;
    const audio = response.audio;
    if (!audio.length || sniffAudioContentType(audio) !== "audio/mpeg") {
      const reason = "Modal clone returned invalid MP3 audio";
      noteAttempt(key, reason, true);
      throw new ModalCloneProviderError(reason);
    }
    // Counted only once the answer is usable audio, so an unusable body spends
    // exactly one attempt against the provider-fault budget.
    noteAttempt(key);
    const verdict = cloneTakeIsTruncated({
      text: input.text,
      durationSeconds: duration,
      truncatedUnits: Number.isFinite(truncatedUnits) ? truncatedUnits : 0,
    });
    if (!verdict.truncated) {
      return {
        audio,
        contentType: "audio/mpeg",
        ...(Number.isFinite(duration) && duration > 0
          ? { durationHintSeconds: duration }
          : {}),
      };
    }
    lastReason = verdict.reason ?? "truncated";
  }
  throw new Error(`Modal clone truncated: ${lastReason}`);
  } finally {
    await slot.release();
  }
}

function attemptKey(catalogVoiceId: string, text: string): string {
  return createHash("sha256")
    .update(catalogVoiceId)
    .update("\0")
    .update(text)
    .digest("hex");
}

function attemptState(key: string): AttemptState {
  return attempts.get(key) ?? EMPTY_ATTEMPT;
}

/**
 * Record what happened to one section.
 *
 * `hardFault` marks a provider fault (a 5xx or unusable audio) rather than a
 * truncated take. The distinction is what stops "Modal clone already retried"
 * from being the error a person sees: a hard fault is limited to one extra
 * take and its message is rethrown, while a truncation keeps the older budget.
 */
function noteAttempt(key: string, error: string | null = null, hardFault = false): void {
  const previous = attemptState(key);
  attempts.set(key, {
    count: previous.count + 1,
    hardFaults: previous.hardFaults + (hardFault ? 1 : 0),
    lastError: error ?? previous.lastError,
  });
  if (attempts.size > 4_000) {
    const oldest = attempts.keys().next().value;
    if (oldest) attempts.delete(oldest);
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-echomancer-token": token,
  };
}

function requireToken(): string {
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  return token;
}

/**
 * Whether a container has finished restoring. A `false` answer is expected
 * after idle and is not an error; see {@link ModalCloneColdError}.
 */
export async function modalClonePoolReady(signal?: AbortSignal): Promise<{
  ready: boolean;
  warmContainers: number;
  build: string | null;
}> {
  if (!modalCloneReadyProbeEnabled()) {
    // No probe: assume reachable and let the call's own timeout decide.
    return { ready: true, warmContainers: -1, build: null };
  }
  let url: string | null;
  try {
    url = modalReadyUrl();
  } catch (err) {
    // A misconfigured URL is worse than no probe: refuse loudly in a log and
    // let the call itself decide, rather than 404 on every section.
    console.warn(
      "[modal-clone] ready probe disabled:",
      err instanceof Error ? err.message : err
    );
    return { ready: true, warmContainers: -1, build: null };
  }
  if (!url) {
    // Only the batch endpoint is configured. There is nothing to probe, so do
    // not invent `${batch}/ready` — that host has no such route.
    return { ready: true, warmContainers: -1, build: null };
  }
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(modalCloneReadyTimeoutMs());
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: authHeaders(requireToken()),
      signal: combined,
    });
  } catch {
    signal?.throwIfAborted();
    return { ready: false, warmContainers: 0, build: null };
  }
  if (response.status === 404) {
    // Ready route not deployed: the deploy predates it. Stay optimistic.
    await response.body?.cancel().catch(() => undefined);
    return { ready: true, warmContainers: -1, build: null };
  }
  const raw = await response.text().catch(() => "");
  let ready = response.ok;
  let warm = 1;
  let build: string | null = null;
  if (raw) {
    try {
      const body = JSON.parse(raw) as {
        ready?: boolean;
        warm_containers?: number;
        build?: string;
      };
      if (body.ready === false) ready = false;
      if (typeof body.warm_containers === "number") warm = body.warm_containers;
      if (typeof body.build === "string") build = body.build;
    } catch {
      ready = response.ok;
    }
  }
  return { ready, warmContainers: warm, build };
}

/**
 * Is a container **provably** finished restoring right now?
 *
 * Different question from {@link modalClonePoolReady}, and the difference is the
 * whole of the saved-preview stall on 2026-11-06.
 *
 * `modalClonePoolReady` is deliberately optimistic: with no probe configured it
 * answers `ready: true, warmContainers: -1` ("assume reachable, let the call's
 * own timeout decide"). That is right for a book, which is asynchronous and can
 * park for a restore. It is wrong for a request that a person is waiting on
 * inside a 60 s serverless function, because "assume reachable" means the call
 * then waits up to `MODAL_S2_COLD_WAIT_MS` (150 s) for a restore the function
 * cannot survive. Vercel kills the request at 60 s, so the take renders on the
 * GPU anyway, nothing is stored under the key the client needed, and the next
 * attempt renders the same line again.
 *
 * So this probe only says `true` when the deployed pool itself reports a live
 * container: `warm_containers >= 1` on a `200`, for *this* build. Everything
 * else — no probe URL, no token, a timeout, a 503, an unrecognised body — is
 * `false` with a reason, and the caller must not open a synthesis call.
 *
 * A missing `MODAL_S2_READY_URL` on Vercel was live production config on
 * 2026-11-06. This function reports that as `no_ready_url` rather than
 * pretending the pool is warm.
 */
export type ModalCloneWarmProbe =
  | { warm: true; build: string | null; warmContainers: number }
  | { warm: false; reason: ModalCloneWarmProbeReason };

export type ModalCloneWarmProbeReason =
  | "probe_disabled"
  | "no_ready_url"
  | "no_token"
  | "timeout"
  | "not_ready"
  | "bad_response";

export async function probeModalCloneWarm(
  signal?: AbortSignal,
  timeoutMs = 4_000
): Promise<ModalCloneWarmProbe> {
  if (!modalCloneReadyProbeEnabled()) return { warm: false, reason: "probe_disabled" };
  let url: string | null;
  try {
    url = modalReadyUrl();
  } catch {
    // A misconfigured host is not a warm pool.
    return { warm: false, reason: "bad_response" };
  }
  if (!url) return { warm: false, reason: "no_ready_url" };
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) return { warm: false, reason: "no_token" };

  const timeout = AbortSignal.timeout(Math.max(250, timeoutMs));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: authHeaders(token),
      signal: combined,
    });
  } catch {
    return { warm: false, reason: "timeout" };
  }

  const raw = await response.text().catch(() => "");
  if (response.status === 404) {
    // The ready route is not deployed, so nothing can be proved about warmth.
    return { warm: false, reason: "no_ready_url" };
  }
  let warmContainers = 0;
  let build: string | null = null;
  let ready = false;
  try {
    const body = JSON.parse(raw || "{}") as {
      ready?: boolean;
      warm_containers?: number;
      build?: string;
    };
    ready = body.ready === true;
    if (typeof body.warm_containers === "number") warmContainers = body.warm_containers;
    if (typeof body.build === "string") build = body.build;
  } catch {
    return { warm: false, reason: "bad_response" };
  }
  if (!response.ok || !ready || warmContainers < 1) {
    return { warm: false, reason: "not_ready" };
  }
  return { warm: true, build, warmContainers };
}

/**
 * Start a restore so the next preview can be a storage read.
 *
 * Fire-and-forget: this exists so a preview that had nothing stored and a cold
 * pool leaves a container warming rather than leaving the next tap exactly as
 * cold. It never waits and never throws.
 */
export function warmClonePoolForPreview(reason: string): boolean {
  return kickModalCloneSnapshotWarm(reason);
}

/**
 * How long one call may wait for a container, and which kind of wait it is.
 *
 * A warm pool gets the steady-state timeout. A pool whose state we cannot
 * read gets the restore budget — never a compile. `kind: "restore"` is what
 * tells a timeout "this placement missed the budget" rather than "a warm
 * container was slow".
 *
 * `raceForFirstAudio` narrows the restore budget to the first-light call.
 * Section 0 is the one call where a longer wait is actively worse: on a
 * placement that turns out to be compiling, the 150 s budget is 150 s spent
 * before the player gets anything, and the compile is finished off-path anyway
 * (#237). Racing for first audio therefore gives up early and lets the retry
 * wave try another container, which is exactly what a cold pool needs.
 *
 * `workMs` is how long the narration in this call is planned to take. The wait
 * has to cover it, or the packer and the timeout disagree: a lane planned
 * against an 80 s generation budget cannot be cut at a 60 s steady timeout.
 * The result is still clamped to {@link MODAL_CLONE_COLD_WAIT_MAX_MS}, so no
 * wait on this path can reach a compile.
 *
 * `warmBatch` is the exception: the container has already answered, so the
 * wait is the warm budget (still under the proxy kill) and a miss is not a
 * compile. Cold and steady calls ignore it.
 */
export function modalCloneCallWait(
  poolKnownWarm: boolean,
  raceForFirstAudio = false,
  workMs = 0,
  warmBatch = false
): ModalCallWait {
  // Same function the planner uses when it decides a cold pack fits.
  return modalCloneArmedWaitMs(poolKnownWarm, raceForFirstAudio, workMs, warmBatch);
}

/** True when a Content-Length is past the batch body ceiling. */
export function modalCloneResponseOverCeiling(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > MODAL_CLONE_RESPONSE_BODY_MAX_BYTES;
}

/**
 * Read a Modal JSON body. A declared length past the ceiling is refused
 * before the body is parsed, so a huge response is not kept as a string.
 */
export async function readModalCloneJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (modalCloneResponseOverCeiling(declared)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModalCloneProviderError(
      `Modal clone response is ${declared} bytes, over the ${MODAL_CLONE_RESPONSE_BODY_MAX_BYTES} byte ceiling`
    );
  }
  return response.json();
}

type ModalCallWait = {
  ms: number;
  kind: "restore" | "steady" | "warm";
  jobId?: string;
  /**
   * The probe saw zero warm containers and no other S2 call. Only then
   * does a miss freeze every book.
   */
  appWideCold?: boolean;
};

/**
 * Whether this call may use the steady budget.
 *
 * `warm_containers > 0` means some container finished restoring. With
 * `max_inputs=1` that container is busy for the book that holds it, so
 * another book's call is placed on a container that still has to restore.
 * Spare warmth is `warm_containers` above the other live GPU leases.
 * A book's first call, and any call before that book has heard its own
 * container, always uses the restore budget. A spare container is still
 * not this book's. Probe unknown (`warmContainers < 0`) is not warmth for
 * an unconfirmed book; a book that already heard its container keeps the
 * warm budget when the probe is missing. A call with no job id keeps the
 * old rule (`warm_containers > 0`).
 */
export function modalCloneKnownWarmForCall(input: {
  warmContainers: number;
  inflightCalls: number;
  bookContainerWarm: boolean;
  jobScoped: boolean;
}): boolean {
  if (!input.jobScoped) return input.warmContainers > 0;
  if (!input.bookContainerWarm) return false;
  if (input.warmContainers < 0) return true;
  if (!Number.isFinite(input.inflightCalls)) return false;
  return input.warmContainers > input.inflightCalls;
}

/**
 * Other books' live GPU leases. This book's own row is the call that has
 * not been posted yet, so it does not count. A ledger that cannot be read
 * is treated as full: an unconfirmed book then still gets the restore
 * budget, and a confirmed book is not given a steady wait it cannot prove.
 */
async function inflightCloneCallsExcluding(jobId: string): Promise<number> {
  try {
    const { listLiveModalGpuLeases } = await import(
      "@/lib/tts/providers/modal-gpu-lease"
    );
    const leases = await listLiveModalGpuLeases();
    return leases.filter((row) => row.jobId !== jobId).length;
  } catch (err) {
    console.warn(
      "[modal-clone] GPU lease ledger unreadable; treating the pool as busy",
      err instanceof Error ? err.message : err
    );
    return Number.POSITIVE_INFINITY;
  }
}

async function assertModalCloneReady(
  signal?: AbortSignal,
  raceForFirstAudio = false,
  workMs = 0,
  warmBatch = false,
  jobId?: string
): Promise<ModalCallWait> {
  const now = Date.now();
  if (jobId && now < (jobColdUntil.get(jobId) ?? 0)) {
    throw new ModalCloneColdError(
      "Modal clone pool is cold (backoff)",
      COLD_BACKOFF_MS,
      "pool"
    );
  }
  const bookWarm = jobId ? modalCloneBookContainerWarm(jobId, now) : false;
  // A confirmed book already has a container. An app-wide clock left by
  // an empty probe must not hold its next ramp call.
  if (now < poolColdUntil && (!jobId || !bookWarm)) {
    throw new ModalCloneColdError(
      "Modal clone pool is cold (backoff)",
      COLD_BACKOFF_MS,
      "pool"
    );
  }
  const inflight = jobId ? await inflightCloneCallsExcluding(jobId) : 0;
  const state = await modalClonePoolReady(signal);
  if (!state.ready) {
    const appWide = state.warmContainers <= 0 && inflight === 0;
    // No job id keeps the process-wide clock, including a probe that
    // omitted `warm_containers` (the parser then reports 1).
    if (!jobId || appWide) rememberModalCloneCold();
    if (jobId) rememberModalCloneCold(jobId);
    throw new ModalCloneColdError(
      "Modal clone pool has no warm container",
      COLD_BACKOFF_MS,
      "pool"
    );
  }
  const poolKnownWarm = modalCloneKnownWarmForCall({
    warmContainers: state.warmContainers,
    inflightCalls: inflight,
    bookContainerWarm: bookWarm,
    jobScoped: Boolean(jobId),
  });
  // A process-wide warm flag must not give an unconfirmed book the 400s
  // warm wait. Its own container has not answered yet.
  const honorWarmBatch = warmBatch && (!jobId || bookWarm);
  const wait = modalCloneCallWait(
    poolKnownWarm,
    raceForFirstAudio,
    workMs,
    honorWarmBatch
  );
  return {
    ...wait,
    jobId,
    appWideCold: state.warmContainers === 0 && inflight === 0,
  };
}

/**
 * Skip Modal briefly so the next call does not open another cold wait.
 *
 * With a job id, only that book waits. Without one, the whole process
 * waits — that is the path a probe uses when it is not tied to a book.
 */
export function rememberModalCloneCold(jobId?: string): void {
  const until = Date.now() + COLD_BACKOFF_MS;
  if (jobId) {
    jobColdUntil.set(jobId, until);
    if (jobColdUntil.size > 4_000) {
      const oldest = jobColdUntil.keys().next().value;
      if (oldest) jobColdUntil.delete(oldest);
    }
    return;
  }
  poolColdUntil = until;
}

/**
 * A restore-budget miss is one placement: kick the RPC that is allowed to
 * finish a compile. A gateway miss leaves the backoff unset so dispatch can
 * try another container once. A client timeout sets this book's backoff and
 * dispatch does not post those sections again — the handler is still
 * rendering them. A steady-state miss freezes this book. It freezes every
 * book only when the pool itself is empty, or the call has no book.
 */
function coldFromWait(
  kind: "restore" | "steady" | "warm",
  message: string,
  ctx: { jobId?: string; appWide?: boolean; clientAborted?: boolean } = {}
): ModalCloneColdError {
  const aborted = ctx.clientAborted === true;
  if (kind === "warm") {
    // The container had answered, so this is a slow or gone GPU, not a
    // compile. Drop that book's warmth. Do not kick `::cover` and do not
    // freeze other books. `waitKind` is what the dispatch checks, so a
    // placement scope cannot kick a compile anyway.
    if (ctx.jobId) forgetModalCloneBookWarm(ctx.jobId);
    else noteModalClonePoolLost();
    if (aborted) rememberModalCloneCold(ctx.jobId);
    return new ModalCloneColdError(
      message,
      COLD_BACKOFF_MS,
      "placement",
      "warm",
      aborted
    );
  }
  if (kind === "restore") {
    kickModalCloneSnapshotWarm(message);
    if (aborted) rememberModalCloneCold(ctx.jobId);
    return new ModalCloneColdError(
      message,
      COLD_BACKOFF_MS,
      "placement",
      "restore",
      aborted
    );
  }
  const appWide = ctx.appWide === true || !ctx.jobId;
  if (appWide) rememberModalCloneCold();
  if (ctx.jobId) rememberModalCloneCold(ctx.jobId);
  return new ModalCloneColdError(
    message,
    COLD_BACKOFF_MS,
    "pool",
    "steady",
    aborted
  );
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  wait?: ModalCallWait
): Promise<unknown> {
  const response = await postModal(url, body, signal, wait);
  return readModalCloneJson(response);
}

/**
 * Render one section.
 *
 * The dedicated `/synthesize` endpoint answers raw audio with its own body
 * shape. When it is not configured the call goes through `/synthesize_batch`
 * as a **one-row batch** instead of posting a single-section body at the batch
 * host — that mismatch is a guaranteed 400, and it only arrives after the GPU
 * has restored, so it used to cost a cold start and then a fallback voice.
 *
 * Both shapes are decoded here into the same `{audio, duration, truncated}`
 * answer, so the retry ledger below cannot tell them apart.
 */
async function postSynthesize(
  input: SynthesizeInput,
  reference: CloneReference,
  retry: boolean,
  epoch: number,
  wait?: ModalCallWait
): Promise<{ audio: Buffer; durationSeconds: number; truncatedUnits: number }> {
  const single = modalSingleUrl();
  const batchRowKey = "single";
  if (single) {
    const response = await postModal(
      single,
      {
        text: input.text,
        reference_audio_base64: reference.audio.toString("base64"),
        reference_text: reference.transcript,
        sampling: MODAL_S2_SAMPLING,
        ...(input.jobId ? { job_id: input.jobId } : {}),
        seed_epoch: epoch,
        // An explicit seed keeps an older container build (which only knows
        // `seed`) producing a fresh take on a retry.
        ...(retry ? { seed: nextSeed() } : {}),
      },
      input.signal,
      wait
    );
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length > 0) noteModalClonePoolAnswered(Date.now(), input.jobId);
    return {
      audio,
      durationSeconds: Number(response.headers.get("x-s2-duration")),
      truncatedUnits: Number(response.headers.get("x-s2-truncated")),
    };
  }

  const payload = (await postJson(
    modalBatchUrl(),
    {
      items: [{ key: batchRowKey, text: input.text }],
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: MODAL_S2_SAMPLING,
      ...(input.jobId ? { job_id: input.jobId } : {}),
      seed_epoch: epoch,
      ...(retry ? { seed: nextSeed() } : {}),
    },
    input.signal,
    wait
  )) as BatchResponse;
  const row = (payload.items ?? []).find((item) => item.key === batchRowKey)
    ?? (payload.items ?? [])[0];
  if (!row) {
    throw new ModalCloneProviderError(
      "Modal clone batch returned no row for a single-section request"
    );
  }
  if (row.error) {
    throw new ModalCloneProviderError(
      `Modal clone: ${row.error_code ? `${row.error_code}: ` : ""}${row.error}`
    );
  }
  const decoded = decodeBatchAudio(row);
  if (!decoded) {
    throw new ModalCloneProviderError(
      "Modal clone returned a row without decodable audio"
    );
  }
  noteModalClonePoolAnswered(Date.now(), input.jobId);
  return {
    audio: decoded.audio,
    durationSeconds: decoded.durationSeconds,
    truncatedUnits: Number(row.truncated_units) || 0,
  };
}

function nextSeed(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

/**
 * One HTTP call to one endpoint origin.
 *
 * `url` is a full endpoint origin, never a base to append to: Modal serves each
 * web endpoint on its own hostname. A transport-level failure, a 502/503/504,
 * or a restore that ran past its deadline becomes {@link ModalCloneColdError}.
 * A restore-budget miss is `placement` and does not start the backoff, so
 * another lane can try a different container. A steady-state miss is `pool`.
 * Only a real provider answer surfaces as a normal error.
 */
async function postModal(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  wait?: ModalCallWait
): Promise<Response> {
  signal?.throwIfAborted();
  const limit = wait && wait.ms > 0 ? wait.ms : modalCloneCallTimeoutMs();
  const kind = wait?.kind ?? "steady";
  const timeout = AbortSignal.timeout(limit);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeaders(requireToken()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    signal?.throwIfAborted();
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      // The worker dropped the wait. The sync handler keeps the GPU.
      // `clientAborted` tells dispatch not to POST these sections again.
      throw coldFromWait(
        kind,
        `Modal clone did not answer within ${Math.round(limit / 1000)}s`,
        {
          jobId: wait?.jobId,
          appWide: wait?.appWideCold,
          clientAborted: true,
        }
      );
    }
    throw err;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const refused = modalPlatformRefusal(response.status, detail);
    if (refused) {
      // The body can carry an account id. Log the redacted sentence only.
      console.warn(
        `[modal] workspace disabled http=${response.status} ${redactModalAccount(detail).slice(0, 160)}`
      );
      throw refused;
    }
    // A 404 that is not a disabled workspace still means this hostname is
    // not the deployed web endpoint. It is not a cold container. The
    // platform's "workspace is disabled" body is handled above and is not
    // this case.
    if (response.status === 404) {
      throw new Error(
        `Modal clone endpoint not found at ${new URL(url).host}. Each web endpoint is its own hostname; check MODAL_S2_TTS_URL and MODAL_S2_READY_URL.`
      );
    }
    // A gateway timeout means the container is not serving. On a restore wait
    // that is one placement (often a compile the proxy is about to kill), not
    // a reason to freeze every other lane.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw coldFromWait(
        kind,
        `Modal clone TTS ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        { jobId: wait?.jobId, appWide: wait?.appWideCold }
      );
    }
    if (response.status === 429) {
      // Backstop. The deployed class is `@modal.concurrent(max_inputs=1)`,
      // so Modal places a second POST on another container instead of
      // answering 429. A container that still returns `lane_busy` is busy,
      // not cold, and must not start a backoff.
      throw new ModalCloneLaneBusyError(
        `Modal clone lane busy${detail ? `: ${detail.slice(0, 200)}` : ""}`
      );
    }
    if (response.status === 422 && /reference/i.test(detail)) {
      throw new ModalCloneReferenceError(
        `Modal clone rejected the reference: ${detail.slice(0, 300)}`
      );
    }
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      // A 401/403 is the account. A 500 is the container's own exception.
      // Neither is a cold start: retrying it cannot help, and burning the
      // cold placement budget on it is how `job 5f09ee0e` ended with
      // "Modal clone already retried" instead of the real TypeError.
      // Surfaced as a hard fault so the caller can fall through to the
      // engine fallback rather than park the book as if it were cold.
      throw new ModalCloneProviderError(
        `Modal clone TTS ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        response.status
      );
    }
    throw new Error(
      `Modal clone TTS ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }
  return response;
}

/** Delay the worker should wait before trying a cold pool again. */
export function modalCloneNextRetryDelayMs(attempt: number): number {
  return modalCloneRetryDelayMs(attempt);
}

function decodeBatchAudio(row: BatchRow): { audio: Buffer; durationSeconds: number } | null {
  const b64 = rowAudioB64(row);
  if (!b64) return null;
  const audio = Buffer.from(b64, "base64");
  if (!audio.length || sniffAudioContentType(audio) !== "audio/mpeg") return null;
  return { audio, durationSeconds: Number(row.duration_s) || 0 };
}

/** Server field is `audio_b64`. `audio_base64` remains accepted. */
function rowAudioB64(row: BatchRow): string {
  const primary = typeof row.audio_b64 === "string" ? row.audio_b64.trim() : "";
  const legacy = typeof row.audio_base64 === "string" ? row.audio_base64.trim() : "";
  return primary || legacy;
}
