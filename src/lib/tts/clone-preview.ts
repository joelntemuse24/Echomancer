/**
 * One derivation for a saved clone's short preview.
 *
 * Three routes need the exact same answer to "what is this clone's saved
 * preview, and what would re-rendering it produce?":
 *
 *   - `GET /api/tts/clones/[id]/preview` — serve a saved MP3. It never
 *     synthesizes, so selecting a saved voice cannot start a GPU restore.
 *   - `POST /api/tts/clones/[id]/preview` — explicitly render one, once, on the
 *     engine that actually speaks this clone.
 *   - `GET /api/tts/live` — the streaming route, which reuses the same plan so
 *     its stored key can never drift from the one the cache route reads.
 *
 * If those derived the script differently the key would not match, every play
 * would look like a cache miss, and a saved clone would synthesize again on
 * every tap.
 *
 * ## Engine
 *
 * Books may use the S2 pool. The preview bake does not. It is one Fish render
 * of `PREVIEW_TEXT` with this clone's `reference_id`, stored under the `fish`
 * key. Lookup reads that fish key, then the legacy Fish 2.1 file, then an
 * older `s2-pro` take. Drama 3 has no key.
 */

import { createHash } from "crypto";

import { mapPool } from "@/lib/async-pool";
import type { DeliveryUserInput } from "@/lib/tts/delivery-settings";
import { resolveDeliverySettings } from "@/lib/tts/delivery-settings";
import {
  catalogIdForClone,
  cloneRowIdFromCatalogId,
  isFishCloneCatalogId,
  type ClonedVoiceRow,
} from "@/lib/tts/fish-clone";
import {
  fishSpeedForRequest,
  initialNarrationSpeed,
} from "@/lib/tts/narration-pace";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { usesModalClone } from "@/lib/tts/providers/modal-clone";
import {
  CLONE_PREVIEW_ABSENT_TTL_SEC,
  CLONE_PREVIEW_PATH_ABSENT,
  rememberClonePreviewMiss,
  rememberClonePreviewPath,
} from "@/lib/tts/clone-preview-record";
import { isClonePreviewObjectPath } from "@/lib/tts/clone-preview-media";
import {
  clonePreviewLookupPaths,
  clonePreviewPublicUrl,
  clonePreviewStoragePath,
  clonePreviewVersionToken,
  findExistingClonePreviewPath,
  locateClonePreview,
  readFirstStoredClonePreview,
  type ClonePreviewEngine,
  type ClonePreviewKeyInput,
  type StoredClonePreview,
} from "@/lib/tts/clone-preview-store";
import { clonePreviewStreamResponse } from "@/lib/tts/clone-preview-stream";

/** A stored clip can sit in the browser cache until the recipe or the key changes. */
export const CLONE_PREVIEW_AUDIO_CACHE = "private, max-age=31536000, immutable";

/** A bake in progress, or a failed bake, must not be replayed from cache. */
export const CLONE_PREVIEW_STATUS_CACHE = "private, no-store";

/**
 * Shared caches, including the Vercel CDN, must not store a clone preview.
 * The browser still follows `Cache-Control`. `private` alone is the spec;
 * these two headers are what Vercel reads for its own cache.
 */
export const CLONE_PREVIEW_CDN_CACHE = "no-store";

/** How many unknown clones a voices request may stat at once. */
export const CLONE_PREVIEW_PROBE_CONCURRENCY = 4;

/** Same ceiling the live route applies to any sample text. */
export const MAX_PREVIEW_CHARS = 2_000;

export type ClonePreviewPlan = {
  /** Exact text handed to the engine. */
  script: string;
  /** Fish `prosody.speed`; undefined means the provider default. */
  speed: number | undefined;
};

/**
 * Which engine renders this clone, for naming the stored take.
 *
 * Read from configuration only, so the answer is stable for the lifetime of a
 * request: a preview rendered by S2 is keyed `s2-pro`, and one rendered by the
 * direct Fish API is keyed `fish`. Lookup still tries fish, then legacy, then
 * s2-pro, whatever this returns. New bakes pass `fish` explicitly.
 */
export function clonePreviewEngine(catalogVoiceId: string): ClonePreviewEngine {
  return usesModalClone(catalogVoiceId) ? "s2-pro" : "fish";
}

/** The script and speed a preview request resolves to. */
export function planClonePreview(input: {
  catalogVoiceId: string;
  text: string;
  ttsOptions?: DeliveryUserInput | null;
}): ClonePreviewPlan {
  // A clone's one-liner ignores delivery preferences; see
  // `previewDeliveryInput`, which every route goes through.
  const delivery = resolveDeliverySettings(
    input.text,
    previewDeliveryInput(input.catalogVoiceId, input.text, input.ttsOptions)
  );
  const speakable = toSpeakableText(input.text, {
    normalizeTitles: delivery.normalizeTitles,
  }).slice(0, MAX_PREVIEW_CHARS);
  const script = narrationScriptForSynthesis(speakable, "fish", {
    pauseStyle: delivery.pauseStyle,
    deliveryPrefix: delivery.deliveryPrefix,
  });
  return {
    script,
    speed: fishSpeedForRequest(
      initialNarrationSpeed({
        catalogVoiceId: input.catalogVoiceId,
        text: input.text,
      })
    ),
  };
}

/**
 * The delivery knobs that apply to this preview.
 *
 * A clone's picker sample is one fixed product line, not book narration, so it
 * ignores the person's delivery preferences. That is what keeps the stored key
 * stable: the cache route has no preferences to apply, so if the live route
 * honoured them here the two would derive different keys and a saved clip
 * would never be found again.
 */
export function previewDeliveryInput(
  catalogVoiceId: string,
  text: string,
  ttsOptions: DeliveryUserInput | null | undefined
): DeliveryUserInput | null | undefined {
  if (text === PREVIEW_TEXT && isFishCloneCatalogId(catalogVoiceId)) return undefined;
  return ttsOptions;
}

export type ClonePreviewVoice = {
  id: string;
  providerVoiceId?: string | null;
  model?: string | null;
};

function keyInputFor(
  voice: ClonePreviewVoice,
  plan: ClonePreviewPlan
): ClonePreviewKeyInput {
  return {
    catalogVoiceId: voice.id,
    providerVoiceId: voice.providerVoiceId,
    model: voice.model,
    script: plan.script,
    speed: plan.speed,
  };
}

/**
 * True when this request is the shared one-liner, which is the only thing a
 * preview is ever stored for. Custom sample text would grow the bucket with one
 * file per line anybody typed.
 */
export function isStorablePreview(text: string): boolean {
  return text === PREVIEW_TEXT;
}

/**
 * Where a take rendered now by this clone's engine is stored. Null when this
 * request is not the shared one-liner, or the clone has no reference id.
 *
 * This is the **only** key anything may write to, and it names the engine.
 */
export function clonePreviewWritePath(
  voice: ClonePreviewVoice,
  plan: ClonePreviewPlan,
  text: string = PREVIEW_TEXT,
  engine: ClonePreviewEngine = clonePreviewEngine(voice.id)
): string | null {
  if (!isStorablePreview(text)) return null;
  return clonePreviewStoragePath(keyInputFor(voice, plan), engine);
}

/** Kept for callers that only need the write path. */
export const clonePreviewPathForCatalog = clonePreviewWritePath;

/**
 * Every key that may already hold this clone's preview, best first: the fish
 * bake, then the legacy engine-free key that holds the Fish 2.1 Pro MP3s,
 * then an older s2-pro take.
 */
export function clonePreviewReadPaths(
  voice: ClonePreviewVoice,
  plan: ClonePreviewPlan,
  text: string = PREVIEW_TEXT,
  engine: ClonePreviewEngine = clonePreviewEngine(voice.id)
): string[] {
  if (!isStorablePreview(text)) return [];
  return clonePreviewLookupPaths(keyInputFor(voice, plan), engine);
}

/**
 * The saved preview for this clone, or null when nothing usable is stored.
 *
 * A legacy Fish 2.1 object counts: it is this voice, on the model that trained
 * the reference, and it is already paid for. Reusing it is what makes an older
 * clone preview instantly instead of paying a cold GPU restore to re-render
 * the same line on S2.
 */
export async function findStoredClonePreview(
  voice: ClonePreviewVoice,
  plan: ClonePreviewPlan,
  text: string = PREVIEW_TEXT,
  engine: ClonePreviewEngine = clonePreviewEngine(voice.id)
): Promise<StoredClonePreview | null> {
  if (!isStorablePreview(text)) return null;
  return readFirstStoredClonePreview(keyInputFor(voice, plan), engine);
}

/** Strong ETag for one stored (or just generated) clip. */
export function clonePreviewEtag(
  storagePath: string,
  audio: Uint8Array
): string {
  const hash = createHash("sha256")
    .update(storagePath)
    .update(audio)
    .digest("hex")
    .slice(0, 32);
  return `"${hash}"`;
}

/** True when `If-None-Match` already names this clip, or is `*`. */
export function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const token = part.trim();
    return token === "*" || token === etag;
  });
}

/**
 * A finished clip the browser can hand straight to an audio element.
 *
 * `private, max-age=31536000, immutable` plus an ETag: the URL's version
 * token changes when the recipe or the stored key changes, so the browser
 * may keep the bytes for a year. A one-liner take is tens of kilobytes, so
 * serving the bytes is simpler and faster than a presign round-trip plus a
 * second connection to R2. `Vary: Cookie` keeps one person's clip off
 * another's cache entry.
 */
export function previewAudioResponse(
  audio: Buffer | Uint8Array,
  source: "stored" | "generated",
  storagePath?: string | null
): Response {
  const bytes = new Uint8Array(audio);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(bytes.byteLength),
      ...previewAudioHeaders(clonePreviewEtag(storagePath || source, bytes), source),
    },
  });
}

/** Headers that keep one person's clip in their browser and out of a shared cache. */
export function clonePreviewCacheHeaders(
  cacheControl: string
): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "CDN-Cache-Control": CLONE_PREVIEW_CDN_CACHE,
    "Vercel-CDN-Cache-Control": CLONE_PREVIEW_CDN_CACHE,
    Vary: "Cookie",
  };
}

/** `202` and `409` (and any other non-audio answer) must not be stored. */
export function clonePreviewStatusHeaders(): Record<string, string> {
  return clonePreviewCacheHeaders(CLONE_PREVIEW_STATUS_CACHE);
}

function previewAudioHeaders(
  etag: string,
  source?: "stored" | "generated"
): Record<string, string> {
  const headers: Record<string, string> = {
    ...clonePreviewCacheHeaders(CLONE_PREVIEW_AUDIO_CACHE),
    ETag: etag,
  };
  if (source) headers["X-Echomancer-Preview"] = source;
  return headers;
}

/**
 * 200 with the bytes, or 304 when the browser already has this ETag.
 * The 304 carries the same cache headers so the entry stays immutable.
 */
export function previewAudioOrNotModified(
  request: { headers: { get(name: string): string | null } },
  audio: Buffer | Uint8Array,
  source: "stored" | "generated",
  storagePath?: string | null
): Response {
  const bytes = new Uint8Array(audio);
  const etag = clonePreviewEtag(storagePath || source, bytes);
  if (ifNoneMatchSatisfied(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: previewAudioHeaders(etag) });
  }
  return previewAudioResponse(audio, source, storagePath);
}

/**
 * URL for a clone that already has a stored preview, or null when it does not.
 * Does not bake and does not download the MP3.
 */
export async function cloneCatalogPreviewUrl(
  voice: ClonePreviewVoice
): Promise<string | null> {
  const plan = planClonePreview({ catalogVoiceId: voice.id, text: PREVIEW_TEXT });
  const path = await findExistingClonePreviewPath(keyInputFor(voice, plan));
  if (!path) return null;
  return clonePreviewPublicUrl(voice.id, path) || null;
}

const FILE_VERSION_TOKEN = /^[a-f0-9]{16}$/;

/**
 * A remembered key this voice is allowed to stream.
 *
 * The column is not a free-form object key. It has to be one of this
 * clone's fish, legacy, or s2-pro paths, so a poisoned value cannot read
 * another clone's preview.
 */
function candidateSavedPath(
  savedPath: string | null | undefined,
  candidates: readonly string[]
): string | null {
  if (!savedPath || savedPath === CLONE_PREVIEW_PATH_ABSENT) return null;
  if (!isClonePreviewObjectPath(savedPath)) return null;
  return candidates.includes(savedPath) ? savedPath : null;
}

/**
 * The object to stream, with no storage read.
 *
 * A 16-hex `v` token is the recipe plus one candidate key. The stored
 * `preview_storage_path` is used when that token is absent or does not
 * match, and only when it is one of this clone's keys. Anything else
 * (including the probe's recipe id, or a path for a different clone) is a
 * miss here, and the caller may walk the keys.
 */
export function resolveClonePreviewHotPath(input: {
  voice: ClonePreviewVoice;
  plan: ClonePreviewPlan;
  savedPath: string | null | undefined;
  versionToken: string | null | undefined;
}): { path: string; resolve: "stored" | "token" } | null {
  const candidates = clonePreviewLookupPaths(keyInputFor(input.voice, input.plan));
  const token = input.versionToken?.trim() || "";
  if (FILE_VERSION_TOKEN.test(token)) {
    const matched = candidates.find((path) => clonePreviewVersionToken(path) === token);
    if (matched) return { path: matched, resolve: "token" };
  }
  const saved = candidateSavedPath(input.savedPath, candidates);
  if (saved) return { path: saved, resolve: "stored" };
  return null;
}

type PreviewHeaderRequest = {
  headers: { get(name: string): string | null };
  signal?: AbortSignal;
};

/**
 * Serve a stored clip. The hot path streams a candidate key and refuses a
 * silent or non-audio object from its opening bytes. A token that misses
 * still tries the remembered key before the walk. The walk downloads each
 * remaining key and still refuses a silent file.
 */
export async function respondStoredClonePreview(input: {
  request: PreviewHeaderRequest;
  voice: ClonePreviewVoice;
  plan: ClonePreviewPlan;
  savedPath: string | null | undefined;
  versionToken: string | null;
}): Promise<Response | null> {
  const startedAt = performance.now();
  const candidates = clonePreviewLookupPaths(keyInputFor(input.voice, input.plan));
  const hot = resolveClonePreviewHotPath(input);
  const saved = candidateSavedPath(input.savedPath, candidates);
  const attempts: { path: string; resolve: "stored" | "token" }[] = [];
  if (hot) attempts.push(hot);
  if (saved && saved !== hot?.path) attempts.push({ path: saved, resolve: "stored" });
  for (const attempt of attempts) {
    const streamed = await clonePreviewStreamResponse(input.request, attempt.path, {
      cache: "private",
      resolve: attempt.resolve,
      startedAt,
    });
    if (streamed) {
      if (input.savedPath !== attempt.path) {
        void noteStoredClonePreview(input.voice.id, attempt.path);
      }
      return streamed;
    }
  }

  const walkedAt = performance.now();
  const stored = await findStoredClonePreview(input.voice, input.plan);
  if (!stored) return null;
  await noteStoredClonePreview(input.voice.id, stored.path);
  const response = previewAudioOrNotModified(
    input.request,
    stored.audio,
    "stored",
    stored.path
  );
  response.headers.set("X-Echomancer-Preview-Resolve", "walk");
  response.headers.set(
    "Server-Timing",
    `walk;dur=${(performance.now() - walkedAt).toFixed(1)}, total;dur=${(performance.now() - startedAt).toFixed(1)}`
  );
  return response;
}

/** Remember a clip the preview route or the bake just found. */
export async function noteStoredClonePreview(
  catalogVoiceId: string,
  storagePath: string
): Promise<void> {
  const id = isFishCloneCatalogId(catalogVoiceId)
    ? catalogVoiceId
    : `clone:${catalogVoiceId}`;
  const rowId = cloneRowIdFromCatalogId(id);
  if (!rowId || !storagePath) return;
  await rememberClonePreviewPath(rowId, storagePath);
}

function rememberedPreviewUrl(
  voice: ClonePreviewVoice,
  row: ClonedVoiceRow,
  nowSec: number
): { url: string } | "skip" | "probe" {
  const plan = planClonePreview({ catalogVoiceId: voice.id, text: PREVIEW_TEXT });
  const candidates = clonePreviewLookupPaths(keyInputFor(voice, plan));
  const saved = row.preview_storage_path;
  if (saved && candidates.includes(saved)) {
    const url = clonePreviewPublicUrl(voice.id, saved);
    if (url) return { url };
  }
  const probedAt = Number(row.preview_probed_at) || 0;
  if (
    saved === CLONE_PREVIEW_PATH_ABSENT &&
    probedAt > 0 &&
    nowSec - probedAt < CLONE_PREVIEW_ABSENT_TTL_SEC
  ) {
    return "skip";
  }
  return "probe";
}

/**
 * Fill `previewUrl` for clones that already have a clip.
 *
 * A remembered key is free. Unknown clones are stated a few at a time, then
 * the hit or the miss is stored. Nothing here bakes, and a storage error is
 * not remembered as "no clip".
 */
export async function attachClonePreviewUrls<T extends ClonePreviewVoice>(
  voices: T[],
  rows: readonly ClonedVoiceRow[]
): Promise<Array<T & { previewUrl?: string }>> {
  const byCatalog = new Map(rows.map((row) => [catalogIdForClone(row.id), row]));
  const nowSec = Math.floor(Date.now() / 1000);
  const out: Array<T & { previewUrl?: string }> = voices.map((voice) => ({ ...voice }));
  const pending: { voice: T; index: number; row: ClonedVoiceRow }[] = [];
  voices.forEach((voice, index) => {
    if (!isFishCloneCatalogId(voice.id)) return;
    const row = byCatalog.get(voice.id);
    if (!row) return;
    const remembered = rememberedPreviewUrl(voice, row, nowSec);
    if (remembered === "skip") return;
    if (remembered !== "probe") {
      out[index] = { ...voice, previewUrl: remembered.url };
      return;
    }
    pending.push({ voice, index, row });
  });

  await mapPool(pending, CLONE_PREVIEW_PROBE_CONCURRENCY, async ({ voice, index, row }) => {
    const plan = planClonePreview({ catalogVoiceId: voice.id, text: PREVIEW_TEXT });
    const located = await locateClonePreview(keyInputFor(voice, plan));
    if (located === "error") return;
    if (located === "miss") {
      await rememberClonePreviewMiss(row.id, row.preview_storage_path, nowSec);
      return;
    }
    await rememberClonePreviewPath(row.id, located.path);
    const url = clonePreviewPublicUrl(voice.id, located.path);
    if (url) out[index] = { ...voice, previewUrl: url };
  });
  return out;
}
