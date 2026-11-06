/**
 * One derivation for a saved clone's short preview.
 *
 * Two routes need the exact same answer to "what text and speed is this
 * clone's preview?": `/api/tts/live` (which synthesizes it when nothing is
 * stored) and `/api/tts/clones/[id]/preview` (which serves the stored take).
 * If those two ever derived the script differently the storage key would not
 * match, every play would look like a cache miss, and a saved clone would
 * synthesize again on every tap — the bug this module exists to prevent.
 *
 * The key itself lives in `clone-preview-store.ts`; this only builds the plan
 * that goes into it and answers with the stored object.
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
import {
  clonePreviewStoragePath,
  readStoredClonePreview,
} from "@/lib/tts/clone-preview-store";

/** Same ceiling the live route applies to any sample text. */
export const MAX_PREVIEW_CHARS = 2_000;

export type ClonePreviewPlan = {
  /** Exact text handed to the provider. */
  script: string;
  /** Fish `prosody.speed`; undefined means the provider default. */
  speed: number | undefined;
};

/** The script and speed a preview request resolves to. */
export function planClonePreview(input: {
  catalogVoiceId: string;
  text: string;
  ttsOptions?: DeliveryUserInput | null;
}): ClonePreviewPlan {
  // A clone's one-liner ignores delivery preferences; see
  // `previewDeliveryInput`, which both routes go through.
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
 * Storage key for this clone's preview, or null when this request is not the
 * shared one-liner. Custom sample text is never stored: it would grow the
 * bucket with one file per line anyone typed.
 */
export function clonePreviewPathForCatalog(
  voice: {
    id: string;
    providerVoiceId?: string | null;
    model?: string | null;
  },
  plan: ClonePreviewPlan,
  text: string = PREVIEW_TEXT
): string | null {
  if (text !== PREVIEW_TEXT) return null;
  return clonePreviewStoragePath({
    catalogVoiceId: voice.id,
    providerVoiceId: voice.providerVoiceId,
    model: voice.model,
    script: plan.script,
    speed: plan.speed,
  });
}

/**
 * The delivery knobs that apply to this preview.
 *
 * A clone's picker sample is one fixed product line, not book narration, so it
 * ignores the person's delivery preferences. That is what keeps the stored key
 * stable: `/api/tts/clones/[id]/preview` has no preferences to apply, so if the
 * live route honoured them here the two would derive different keys and a saved
 * clip would never be found again.
 */
export function previewDeliveryInput(
  catalogVoiceId: string,
  text: string,
  ttsOptions: DeliveryUserInput | null | undefined
): DeliveryUserInput | null | undefined {
  if (text === PREVIEW_TEXT && isFishCloneCatalogId(catalogVoiceId)) return undefined;
  return ttsOptions;
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

/** The stored take for this key as bytes, or null when there is none yet. */
export async function storedClonePreviewAudio(
  storagePath: string
): Promise<Buffer | null> {
  return readStoredClonePreview(storagePath);
}
