/**
 * George is Kokoro's British male voice, bm_george, on the same Modal CPU
 * app as Sowell. It is not an OpenRouter voice and it does not use the
 * Sowell pack. The card is absent until this endpoint is set. That host
 * must be the app that returns x-kokoro-voice: bm_george. Pointing it at
 * an older Sowell-only app fails the take instead of speaking Sowell.
 */

export const GEORGE_CATALOG_VOICE_ID = "george";
export const GEORGE_PROVIDER_VOICE_ID = "bm_george";
/** Pinned Kokoro-82M revision. The voice file hash is checked in the image. */
export const GEORGE_KOKORO_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987";
export const GEORGE_CACHE_VARIANT = `kokoro82m-b-${GEORGE_PROVIDER_VOICE_ID}-${GEORGE_KOKORO_REVISION.slice(0, 12)}`;
export const GEORGE_MAX_CHARS = 2000;
/** Same two containers as Sowell. Not a second fleet. */
export const GEORGE_IN_FLIGHT = 2;

export function georgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GEORGE_ENABLED === "1";
}

export class GeorgeNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeorgeNotConfiguredError";
  }
}

/** The Modal endpoint, or a throw. Loopback is refused on the take-home VM. */
export function georgeEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (!georgeEnabled(env)) {
    throw new GeorgeNotConfiguredError("George is not enabled.");
  }
  const raw = env.GEORGE_URL?.trim() || "";
  if (!raw) throw new GeorgeNotConfiguredError("George is not configured (GEORGE_URL).");
  if (!env.GEORGE_TOKEN?.trim()) {
    throw new GeorgeNotConfiguredError("George is not configured (GEORGE_TOKEN).");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GeorgeNotConfiguredError("GEORGE_URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GeorgeNotConfiguredError("GEORGE_URL must be http or https.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new GeorgeNotConfiguredError("GEORGE_URL is the endpoint host, with no path.");
  }
  const host = url.hostname.toLowerCase();
  if (
    env.WORKER === "1" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    throw new GeorgeNotConfiguredError(
      "George synthesis on the take-home VM is refused."
    );
  }
  return url.origin;
}

export function georgeReady(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    georgeEndpoint(env);
    return true;
  } catch {
    return false;
  }
}
