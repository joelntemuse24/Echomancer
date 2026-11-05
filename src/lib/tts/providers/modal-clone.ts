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
 * The pool scales to zero. A restore is targeted at ~90 s and a full compile
 * is ~15–20 min, so the first call after idle can legitimately wait. When the
 * readiness probe says nothing is warm — or a call dies on a gateway timeout
 * before any audio came back — this module throws {@link ModalCloneColdError}.
 * The worker treats that as "come back later" and parks the book, because
 * book generation is asynchronous and the browser is not waiting on it.
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
import { MODAL_S2_SAMPLING } from "@/lib/tts/providers/s2-sampling";
import {
  blockModalCloneJob,
  cloneTakeIsTruncated,
  modalCloneBatchItems,
  modalCloneCallTimeoutMs,
  modalCloneColdWaitMs,
  modalCloneJobBlocked,
  modalCloneLanes,
  modalCloneReadyProbeEnabled,
  modalCloneReadyTimeoutMs,
  modalCloneRetryDelayMs,
  modalCloneSpendAllowed,
  reserveModalCloneSpend,
  resetModalCloneGuardForTests,
} from "@/lib/tts/providers/modal-clone-guard";

/** Matches the clone reference cap enforced at upload. */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
/** After a cold probe or a timed-out call, skip Modal for this long. */
const COLD_BACKOFF_MS = 30_000;

/**
 * The pool had nothing warm (or a call died before any bytes). Not a failure:
 * the worker defers the book and tries again.
 */
export class ModalCloneColdError extends Error {
  readonly retryAfterMs: number;
  constructor(message = "Modal clone pool is cold", retryAfterMs = COLD_BACKOFF_MS) {
    super(message);
    this.name = "ModalCloneColdError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** The reference sample or transcript cannot prompt a clone. Not retryable. */
export class ModalCloneReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalCloneReferenceError";
  }
}

const attempts = new Map<string, number>();
let notReadyUntil = 0;

export function resetModalCloneRuntimeForTests(): void {
  attempts.clear();
  notReadyUntil = 0;
  resetModalCloneGuardForTests();
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

function cloneBaseUrl(): string {
  const raw = process.env.MODAL_S2_TTS_URL?.trim();
  if (!raw) throw new Error("MODAL_S2_TTS_URL is not configured");
  return raw.replace(/\/+$/, "");
}

function readyUrl(): string {
  const explicit = process.env.MODAL_S2_READY_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `${cloneBaseUrl()}/ready`;
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
  opts?: { seedEpoch?: number }
): Promise<CloneBatchOutcome> {
  if (items.length === 0) {
    return {
      audio: new Map(),
      build: null,
      containerId: null,
      seed: null,
      performance: null,
    };
  }
  const userId = reference.userId || "anonymous";
  const chars = items.reduce((sum, item) => sum + item.text.length, 0);
  if (!(await modalCloneSpendAllowed(userId, chars))) {
    if (jobId) blockModalCloneJob(jobId);
    throw new Error("Modal clone over daily character cap");
  }
  const deadline = await assertModalCloneReady(signal);
  if (!(await reserveModalCloneSpend(userId, chars))) {
    if (jobId) blockModalCloneJob(jobId);
    throw new Error("Modal clone spend could not be recorded");
  }

  const payload = await postJson(
    "/synthesize_batch",
    {
      items: items.map((item) => ({ key: item.key, text: item.text })),
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: MODAL_S2_SAMPLING,
      ...(jobId ? { job_id: jobId } : {}),
      seed_epoch: Math.max(0, Math.floor(opts?.seedEpoch ?? 0)),
    },
    signal,
    deadline
  );
  for (const item of items) noteAttempt(reference.catalogVoiceId, item.text);

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
  }
  if (undecodable.length > 0) {
    throw new Error(
      `Modal clone batch returned ${undecodable.length} row(s) without decodable audio (${undecodable.join(",")})`
    );
  }
  return {
    audio: out,
    build: body.build ?? null,
    containerId: body.container_id ?? null,
    seed: typeof body.seed === "number" ? body.seed : null,
    performance: body.performance ?? null,
  };
}

/**
 * Synthesize one section. Throws so the caller can fall back to Drama 3 on
 * a daily cap, or defer the book on {@link ModalCloneColdError}.
 */
export async function synthesizeModalClone(
  input: SynthesizeInput & { seedEpoch?: number }
): Promise<{ audio: Buffer; contentType: string; durationHintSeconds?: number }> {
  if (input.jobId && modalCloneJobBlocked(input.jobId)) {
    throw new Error("Modal clone over daily character cap");
  }
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  input.signal?.throwIfAborted();

  const reference = await loadCloneReference(input.catalogVoiceId!, input.voiceId);
  const userId = reference.userId;
  const catalogVoiceId = input.catalogVoiceId || input.voiceId;
  if (!(await modalCloneSpendAllowed(userId, input.text.length))) {
    if (input.jobId) blockModalCloneJob(input.jobId);
    throw new Error("Modal clone over daily character cap");
  }
  const deadline = await assertModalCloneReady(input.signal);

  const prior = attempts.get(attemptKey(catalogVoiceId, input.text)) ?? 0;
  if (prior >= 2) throw new Error("Modal clone already retried");
  const tries = prior >= 1 ? 1 : 2;
  let lastReason = "truncated";
  for (let i = 0; i < tries; i++) {
    input.signal?.throwIfAborted();
    const retry = prior + i > 0;
    if (!(await reserveModalCloneSpend(userId, input.text.length))) {
      if (input.jobId) blockModalCloneJob(input.jobId);
      throw new Error("Modal clone spend could not be recorded");
    }
    noteAttempt(catalogVoiceId, input.text);
    const response = await postSynthesize(
      input,
      reference,
      retry,
      // A retry must not replay the same take, so it moves the epoch.
      Math.max(0, Math.floor(input.seedEpoch ?? 0)) + (retry ? 1 : 0),
      deadline
    );
    const duration = Number(response.headers.get("x-s2-duration"));
    const truncatedUnits = Number(response.headers.get("x-s2-truncated"));
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || sniffAudioContentType(audio) !== "audio/mpeg") {
      throw new Error("Modal clone returned invalid MP3 audio");
    }
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
}

function attemptKey(catalogVoiceId: string, text: string): string {
  return createHash("sha256")
    .update(catalogVoiceId)
    .update("\0")
    .update(text)
    .digest("hex");
}

function noteAttempt(catalogVoiceId: string, text: string): void {
  const key = attemptKey(catalogVoiceId, text);
  attempts.set(key, (attempts.get(key) ?? 0) + 1);
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
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(modalCloneReadyTimeoutMs());
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(readyUrl(), {
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
 * How long this call may take. A warm pool gets the steady-state timeout; a
 * pool whose state we cannot read gets the restore-sized wait, because the
 * alternative is aborting a restore that would have finished.
 */
function callDeadlineMs(poolKnownWarm: boolean): number {
  return poolKnownWarm
    ? modalCloneCallTimeoutMs()
    : Math.max(modalCloneColdWaitMs(), modalCloneCallTimeoutMs());
}

async function assertModalCloneReady(signal?: AbortSignal): Promise<number> {
  if (Date.now() < notReadyUntil) {
    throw new ModalCloneColdError("Modal clone pool is cold (backoff)");
  }
  const state = await modalClonePoolReady(signal);
  if (!state.ready) {
    noteCold();
    throw new ModalCloneColdError("Modal clone pool has no warm container");
  }
  return callDeadlineMs(state.warmContainers > 0);
}

function noteCold(): void {
  notReadyUntil = Date.now() + COLD_BACKOFF_MS;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  deadlineMs?: number
): Promise<unknown> {
  const response = await postModal(path, body, signal, deadlineMs);
  return response.json();
}

async function postSynthesize(
  input: SynthesizeInput,
  reference: CloneReference,
  retry: boolean,
  epoch: number,
  deadlineMs?: number
): Promise<Response> {
  return postModal(
    "/synthesize",
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
    deadlineMs
  );
}

function nextSeed(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

/**
 * One HTTP call. A transport-level failure, a 502/503/504, or a restore that
 * ran past its deadline becomes {@link ModalCloneColdError}; only a real
 * provider answer surfaces as a normal error.
 */
async function postModal(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  deadlineMs?: number
): Promise<Response> {
  signal?.throwIfAborted();
  const limit = deadlineMs && deadlineMs > 0 ? deadlineMs : modalCloneCallTimeoutMs();
  const timeout = AbortSignal.timeout(limit);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${cloneBaseUrl()}${path}`, {
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
      noteCold();
      throw new ModalCloneColdError(
        `Modal clone did not answer within ${Math.round(limit / 1000)}s`,
        COLD_BACKOFF_MS
      );
    }
    throw err;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // A gateway timeout means the container is not serving. Remember that so
    // the rest of this book waits instead of opening more GPU calls.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      noteCold();
      throw new ModalCloneColdError(
        `Modal clone TTS ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
      );
    }
    if (response.status === 422 && /reference/i.test(detail)) {
      throw new ModalCloneReferenceError(
        `Modal clone rejected the reference: ${detail.slice(0, 300)}`
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
