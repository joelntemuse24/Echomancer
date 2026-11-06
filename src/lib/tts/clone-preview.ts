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
 * A clone preview is rendered by the engine that renders the clone's books —
 * S2-Pro when the pool is configured, direct Fish otherwise. There is no
 * Drama 3 rung: its take is a different voice, and storing one under this
 * clone's key is exactly the 2026-11-06 incident. So a preview either comes
 * from the right engine or the request fails visibly.
 */

import type { DeliveryUserInput } from "@/lib/tts/delivery-settings";
import { resolveDeliverySettings } from "@/lib/tts/delivery-settings";
import {
  fishSpeedForRequest,
  initialNarrationSpeed,
} from "@/lib/tts/narration-pace";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { isFishCloneCatalogId } from "@/lib/tts/fish-clone";
import { usesModalClone } from "@/lib/tts/providers/modal-clone";
import {
  clonePreviewLookupPaths,
  clonePreviewStoragePath,
  readFirstStoredClonePreview,
  type ClonePreviewEngine,
  type ClonePreviewKeyInput,
  type StoredClonePreview,
} from "@/lib/tts/clone-preview-store";

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
 * direct Fish API is keyed `fish`. Neither is ever looked up under the other.
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
 * Every key that may already hold this clone's preview, best first: the
 * current engine's take, then the legacy engine-free key that holds the Fish
 * 2.1 Pro MP3s rendered before the S2 pool existed.
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

/**
 * A finished clip the browser can hand straight to an audio element.
 *
 * `private, max-age=3600` matters: the picker keeps the bytes as an object URL
 * for the session, and this header stops a reload from re-fetching them. A
 * one-liner take is tens of kilobytes, so serving the bytes is simpler and
 * faster than a presign round-trip plus a second connection to R2.
 */
export function previewAudioResponse(
  audio: Buffer | Uint8Array,
  source: "stored" | "generated"
): Response {
  return new Response(new Uint8Array(audio), {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      "Cache-Control": "private, max-age=3600",
      "X-Echomancer-Preview": source,
    },
  });
}
