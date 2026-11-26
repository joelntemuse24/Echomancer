/**
 * Heart is Kokoro's American female voice, af_heart, on the same Modal CPU
 * app as George and Walter. It uses the stock Kokoro-82M base model and the
 * af_heart voice pack. It is not Drew's fine-tune, not an OpenRouter voice,
 * and not the Sowell pack. The card is absent until this endpoint is set.
 * That host must be the app that returns x-kokoro-voice: af_heart.
 *
 * The customer-facing name lives only in {@link HEART_DISPLAY_NAME}.
 */

import { KOKORO_PRONUNCIATION_SUFFIX } from "@/lib/tts/kokoro-pronunciation";

export const HEART_CATALOG_VOICE_ID = "heart";
/** The one customer-facing name. Catalog id, pack, and env names stay `heart`. */
export const HEART_DISPLAY_NAME = "Esther";
export const HEART_PROVIDER_VOICE_ID = "af_heart";
/** Pinned Kokoro-82M revision. The voice file hash is checked in the image. */
export const HEART_KOKORO_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987";
/**
 * American phonemes (`a`), so this key cannot collide with George's British
 * `bm_george` variant or with Drew's fine-tuned checkpoint key.
 */
export const HEART_CACHE_VARIANT = `kokoro82m-a-${HEART_PROVIDER_VOICE_ID}-${HEART_KOKORO_REVISION.slice(0, 12)}${KOKORO_PRONUNCIATION_SUFFIX}`;
export const HEART_MAX_CHARS = 2000;
/**
 * Pieces of one over-cap section that may run at once. A section is packed to
 * {@link HEART_MAX_CHARS}, so this is only reached by a hand-entered row; the
 * book-level lane count is in `sowell-voice.ts`.
 */
export const HEART_IN_FLIGHT = 2;

export function heartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEART_ENABLED === "1";
}

export class HeartNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeartNotConfiguredError";
  }
}

/** The Modal endpoint, or a throw. Loopback is refused on the take-home VM. */
export function heartEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (!heartEnabled(env)) {
    throw new HeartNotConfiguredError("Esther is not enabled.");
  }
  const raw = env.HEART_URL?.trim() || "";
  if (!raw) throw new HeartNotConfiguredError("Esther is not configured (HEART_URL).");
  if (!env.HEART_TOKEN?.trim()) {
    throw new HeartNotConfiguredError("Esther is not configured (HEART_TOKEN).");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HeartNotConfiguredError("HEART_URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HeartNotConfiguredError("HEART_URL must be http or https.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new HeartNotConfiguredError("HEART_URL is the endpoint host, with no path.");
  }
  const host = url.hostname.toLowerCase();
  if (
    env.WORKER === "1" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    throw new HeartNotConfiguredError(
      "Heart synthesis on the take-home VM is refused."
    );
  }
  return url.origin;
}

export function heartReady(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    heartEndpoint(env);
    return true;
  } catch {
    return false;
  }
}
