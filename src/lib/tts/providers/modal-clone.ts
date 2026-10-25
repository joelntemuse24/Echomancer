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
 * Everything around this module is unchanged: the section pipeline still
 * splits the book, streams section audio, masters each section and joins the
 * MP3s.
 *
 * The container returns a mastered MP3 for the whole section. It applies the
 * spectral chain from `MODAL_S2_MASTERING`; the app's `prepareSectionForStorage`
 * still owns loudness, so a section is normalised exactly once.
 *
 * The container needs the reference transcript: Fish's prompt format drops a
 * reference that has no text. `cloned_voices.reference_transcript` is filled at
 * clone time; older rows fall back to the container's Whisper.
 */
import type { SynthesizeInput } from "@/lib/tts/types";
import { sniffAudioContentType } from "@/lib/tts/pcm-wav";
import { MODAL_S2_SAMPLING } from "@/lib/tts/providers/s2-sampling";

/** Cold container restore is ~20 s; a warm one answers in seconds. */
const REQUEST_TIMEOUT_MS = 180_000;
/** Matches the clone reference cap enforced at upload. */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;

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
  }>(
    `SELECT sample_storage_path, reference_transcript FROM cloned_voices
     WHERE id = ? AND fish_voice_id = ? AND deleted_at IS NULL LIMIT 1`,
    [catalogVoiceId.slice("clone:".length), voiceId]
  );
  if (!clone?.sample_storage_path) throw new Error("Clone reference sample is unavailable");
  const audio = await downloadFile(clone.sample_storage_path);
  if (!audio.length || audio.length > MAX_REFERENCE_BYTES) {
    throw new Error("Clone reference must be between 1 byte and 15 MiB");
  }
  return { audio, transcript: clone.reference_transcript ?? "" };
}

export interface CloneBatchItem {
  key: string;
  text: string;
}

/**
 * Render many sections in one call. Returns audio keyed by the caller's key.
 * A failed call rejects as a whole; the caller falls back per section.
 */
export async function synthesizeModalCloneBatch(
  items: CloneBatchItem[],
  reference: CloneReference,
  signal?: AbortSignal
): Promise<Map<string, { audio: Buffer; durationSeconds: number }>> {
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  signal?.throwIfAborted();

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${cloneBaseUrl()}/synthesize_batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-echomancer-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: items.map((item) => ({ key: item.key, text: item.text })),
      reference_audio_base64: reference.audio.toString("base64"),
      reference_text: reference.transcript,
      sampling: MODAL_S2_SAMPLING,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Modal clone batch ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }

  const payload = (await response.json()) as {
    items: Array<{ key: string; audio_base64: string; duration_s: number; error?: string }>;
  };
  const out = new Map<string, { audio: Buffer; durationSeconds: number }>();
  for (const row of payload.items ?? []) {
    if (row.error || !row.audio_base64) continue;
    const audio = Buffer.from(row.audio_base64, "base64");
    if (!audio.length || sniffAudioContentType(audio) !== "audio/mpeg") continue;
    out.set(row.key, { audio, durationSeconds: Number(row.duration_s) || 0 });
  }
  return out;
}

/**
 * Synthesize one section. Throws so the caller can fall back to Drama 3 on a
 * cold container or a transient failure.
 */
export async function synthesizeModalClone(
  input: SynthesizeInput
): Promise<{ audio: Buffer; contentType: string }> {
  const token = process.env.MODAL_S2_TOKEN?.trim();
  if (!token) throw new Error("MODAL_S2_TOKEN is not configured");
  input.signal?.throwIfAborted();

  const { queryOne } = await import("@/lib/turso");
  const { downloadFile } = await import("@/lib/storage");
  const clone = await queryOne<{
    sample_storage_path: string | null;
    reference_transcript: string | null;
  }>(
    `SELECT sample_storage_path, reference_transcript FROM cloned_voices
     WHERE id = ? AND fish_voice_id = ? AND deleted_at IS NULL LIMIT 1`,
    [input.catalogVoiceId!.slice("clone:".length), input.voiceId]
  );
  if (!clone?.sample_storage_path) throw new Error("Clone reference sample is unavailable");

  const sample = await downloadFile(clone.sample_storage_path);
  if (!sample.length || sample.length > MAX_REFERENCE_BYTES) {
    throw new Error("Clone reference must be between 1 byte and 15 MiB");
  }

  // A cold restore plus a long section can exceed the usual section budget, so
  // the caller's signal and this ceiling are combined.
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  const response = await fetch(`${cloneBaseUrl()}/synthesize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-echomancer-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: input.text,
      reference_audio_base64: sample.toString("base64"),
      reference_text: clone.reference_transcript ?? "",
      sampling: MODAL_S2_SAMPLING,
    }),
    signal,
  });

  if (!response.ok) {
    // Read before cancelling: a cancelled body yields an empty detail string,
    // which hides the container's 422 reason from the logs.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Modal clone TTS ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || sniffAudioContentType(audio) !== "audio/mpeg") {
    throw new Error("Modal clone returned invalid MP3 audio");
  }
  const duration = Number(response.headers.get("x-s2-duration"));
  return {
    audio,
    contentType: "audio/mpeg",
    ...(Number.isFinite(duration) && duration > 0
      ? { durationHintSeconds: duration }
      : {}),
  };
}
