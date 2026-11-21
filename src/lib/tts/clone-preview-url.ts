/**
 * Browser URLs for a saved clone's preview. Safe to import from client code:
 * no storage, no Node APIs.
 *
 * The first read is stable so `Cache-Control: immutable` can hold the MP3.
 * `v` is the recipe id. A recipe bump changes the query and the browser
 * fetches again. Polls after a 202 keep a cache-buster: those answers are
 * `no-store`, and a cached 202 must not satisfy the next poll.
 *
 * When the voices list already knows the stored key it sends a signed
 * cookie-free URL (`clonePreviewPublicUrl`) instead of this probe. This
 * probe is the read used when that URL is not on the card yet. The `v`
 * here is the recipe id, not a file token, so the handler does not treat
 * it as a known object.
 */

/** Keep equal to `CLONE_PREVIEW_RECIPE` in `clone-preview-store.ts`. */
export const CLONE_PREVIEW_REQUEST_VERSION = "clone-preview-v2";

export function clonePreviewProbeUrl(catalogVoiceId: string): string {
  return `/api/tts/clones/${encodeURIComponent(catalogVoiceId)}/preview?v=${encodeURIComponent(CLONE_PREVIEW_REQUEST_VERSION)}`;
}

/** A poll after 202. The timestamp is only on this request. */
export function clonePreviewPollUrl(catalogVoiceId: string, now: number): string {
  return `/api/tts/clones/${encodeURIComponent(catalogVoiceId)}/preview?poll=1&_=${now}`;
}
