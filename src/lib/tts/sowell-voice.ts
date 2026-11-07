/**
 * Sowell is a separate Kokoro-82M voice. It is not a stock Edge voice and
 * it is not a Fish clone. The pack is not in the web bundle. Synthesis is
 * an HTTP call to the Modal CPU app. The take-home VM does not run it.
 */

export const SOWELL_CATALOG_VOICE_ID = "sowell";
export const SOWELL_PACK_SHA256 =
  "a9fa4422864e0048d035ead9ad6a304170f73aec409271903b05c9a789c7510d";
/** Cache identity. The pack hash is in it so another file cannot replay. */
export const SOWELL_CACHE_VARIANT = `sowell-kokoro82m-v1_0-${SOWELL_PACK_SHA256.slice(0, 12)}`;
export const SOWELL_MAX_CHARS = 280;

export function sowellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOWELL_ENABLED === "1";
}

export class SowellNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SowellNotConfiguredError";
  }
}

/** The Modal endpoint, or a throw. Loopback is refused on the take-home VM. */
export function sowellEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (!sowellEnabled(env)) {
    throw new SowellNotConfiguredError("Sowell is not enabled.");
  }
  const raw = env.SOWELL_URL?.trim() || "";
  if (!raw) throw new SowellNotConfiguredError("Sowell is not configured (SOWELL_URL).");
  if (!env.SOWELL_TOKEN?.trim()) {
    throw new SowellNotConfiguredError("Sowell is not configured (SOWELL_TOKEN).");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SowellNotConfiguredError("SOWELL_URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SowellNotConfiguredError("SOWELL_URL must be http or https.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new SowellNotConfiguredError("SOWELL_URL is the endpoint host, with no path.");
  }
  const host = url.hostname.toLowerCase();
  if (
    env.WORKER === "1" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    throw new SowellNotConfiguredError(
      "Sowell synthesis on the take-home VM is refused."
    );
  }
  return url.origin;
}

export function sowellReady(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    sowellEndpoint(env);
    return true;
  } catch {
    return false;
  }
}
