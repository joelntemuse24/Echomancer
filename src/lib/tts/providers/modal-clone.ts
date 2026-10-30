/**
 * Self-hosted S2-Pro clone synthesis on Modal — the DEFAULT clone path.
 *
 * Any cloned voice goes through here once `MODAL_S2_TTS_URL` and
 * `MODAL_S2_TOKEN` are set. Drama 3 (OpenRouter) remains the automatic
 * fallback in `providers/fish.ts`, then direct Fish, so a cold container or a
 * provider outage cannot fail a section.
 *
 * `CLONE_TTS_PROVIDER`:
 *   unset / "modal"  -> this path (default)
 *   "openrouter"     -> Drama 3 only, for rollback
 *   "fish"           -> direct Fish only
 *
 * A cold container compiles for about 20 minutes. The client probes readiness
 * (`MODAL_S2_READY_URL`, or `${MODAL_S2_TTS_URL}/ready`) and aborts each
 * synthesize call inside 30–60s (`MODAL_S2_TIMEOUT_MS`, default 60s) before
 * falling back. `MODAL_S2_READY=0` skips the probe.
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
  modalCloneCallTimeoutMs,
  modalCloneJobBlocked,
  modalCloneReadyProbeEnabled,
  modalCloneReadyTimeoutMs,
  modalCloneSpendAllowed,
  reserveModalCloneSpend,
  resetModalCloneGuardForTests,
} from "@/lib/tts/providers/modal-clone-guard";

/** Matches the clone reference cap enforced at upload. */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
/** After a cold probe or a timed-out call, skip Modal for this long. */
const COLD_BACKOFF_MS = 30_000;

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

/** Rollback switch: Drama 3 only. */
export function cloneProviderIsOpenRouter(): boolean {
  return cloneProvider() === "openrouter";
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
 * call, 55–65x when the batch is full. Keep it at or below the worker's
 * `S2B_BATCH` (default 32); extra sections spill into a second call.
 */
export function modalCloneBatchSize(): number {
  const raw = Number(process.env.MODAL_S2_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.min(32, Math.floor(raw)) : 24;
}

/** Concurrent section requests for one book. One batch call fills many rows. */
export function modalCloneSectionConcurrency(): number {
  const raw = Number(process.env.MODAL_S2_SECTION_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.floor(raw)) : 1;
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
  if (!clone?.sample_storage_path) throw new Error("Clone reference sample is unavailable");
  const audio = await downloadFile(clone.sample_storage_path);
  if (!audio.length || audio.length > MAX_REFERENCE_BYTES) {
    throw new Error("Clone reference must be between 1 byte and 15 MiB");
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
};

/**
 * Render many sections in one call. Returns audio keyed by the caller's key.
 * A failed call rejects as a whole; the caller falls back per section.
 * Rows the server marked truncated, or whose audio is far too short for the
 * text, are left out so the per-section path can retry once.
 */
export async function synthesizeModalCloneBatch(
  items: CloneBatchItem[],
  reference: CloneReference,
  signal?: AbortSignal,
  jobId?: string
): Promise<Map<string, { audio: Buffer; durationSeconds: number }>> {
  if (items.length === 0) return new Map();
  const userId = reference.userId || "anonymous";
  const chars = items.reduce((sum, item) => sum + item.text.length, 0);
  if (!(await modalCloneSpendAllowed(userId, chars))) {
    if (jobId) blockModalCloneJob(jobId);
    throw new Error("Modal clone over daily character cap");
  }
  await assertModalCloneReady(signal);
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
    },
    signal
  );
  for (const item of items) noteAttempt(reference.catalogVoiceId, item.text);

  const body = payload as { items?: BatchRow[] };
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
  return out;
}

/**
 * Synthesize one section. Throws so the caller can fall back to Drama 3 on a
 * cold container, a truncated take, or a daily cap.
 */
export async function synthesizeModalClone(
  input: SynthesizeInput
): Promise<{ audio: Buffer; contentType: string; durationHintSeconds?: number }> {
  if (input.jobId && modalCloneJobBlocked(input.jobId)) {
    throw new Error("Modal clone over daily character cap");
  }
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  input.signal?.throwIfAborted();

  const { queryOne } = await import("@/lib/turso");
  const { downloadFile } = await import("@/lib/storage");
  const clone = await queryOne<{
    sample_storage_path: string | null;
    reference_transcript: string | null;
    user_id: string | null;
  }>(
    `SELECT sample_storage_path, reference_transcript, user_id FROM cloned_voices
     WHERE id = ? AND fish_voice_id = ? AND deleted_at IS NULL LIMIT 1`,
    [input.catalogVoiceId!.slice("clone:".length), input.voiceId]
  );
  if (!clone?.sample_storage_path) throw new Error("Clone reference sample is unavailable");

  const sample = await downloadFile(clone.sample_storage_path);
  if (!sample.length || sample.length > MAX_REFERENCE_BYTES) {
    throw new Error("Clone reference must be between 1 byte and 15 MiB");
  }

  const userId = clone.user_id || "anonymous";
  const catalogVoiceId = input.catalogVoiceId || input.voiceId;
  if (!(await modalCloneSpendAllowed(userId, input.text.length))) {
    if (input.jobId) blockModalCloneJob(input.jobId);
    throw new Error("Modal clone over daily character cap");
  }
  await assertModalCloneReady(input.signal);

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
    const response = await postSynthesize(input, sample, clone.reference_transcript ?? "", retry);
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

function nextSeed(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
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

async function assertModalCloneReady(signal?: AbortSignal): Promise<void> {
  if (!modalCloneReadyProbeEnabled()) return;
  if (Date.now() < notReadyUntil) throw new Error("Modal clone not ready");
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
    noteCold();
    throw new Error("Modal clone not ready");
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const raw = await response.text().catch(() => "");
  let ready = response.ok;
  if (raw) {
    try {
      const body = JSON.parse(raw) as { ready?: boolean };
      if (body.ready === false) ready = false;
    } catch {
      ready = response.ok;
    }
  }
  if (!ready) {
    noteCold();
    throw new Error("Modal clone not ready");
  }
}

function noteCold(): void {
  notReadyUntil = Date.now() + COLD_BACKOFF_MS;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await postModal(path, body, signal);
  return response.json();
}

async function postSynthesize(
  input: SynthesizeInput,
  sample: Buffer,
  transcript: string,
  retry: boolean
): Promise<Response> {
  return postModal(
    "/synthesize",
    {
      text: input.text,
      reference_audio_base64: sample.toString("base64"),
      reference_text: transcript,
      sampling: MODAL_S2_SAMPLING,
      ...(retry ? { seed: nextSeed() } : {}),
    },
    input.signal
  );
}

async function postModal(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(modalCloneCallTimeoutMs());
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
    noteCold();
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("Modal clone timed out");
    }
    throw err;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // A gateway timeout means the container is not serving. Remember that so
    // the rest of this book falls back instead of opening more GPU calls.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      noteCold();
    }
    throw new Error(
      `Modal clone TTS ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }
  return response;
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
