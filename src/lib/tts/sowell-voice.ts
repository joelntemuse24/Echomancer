/**
 * Sowell is a separate Kokoro-82M voice. It is not a stock Edge voice and
 * it is not a Fish clone. The pack is not in the web bundle. Synthesis is
 * an HTTP call to the Modal CPU app. The take-home VM does not run it.
 */

import { SOWELL_CATALOG_VOICE_ID } from "@/lib/tts/sowell-id";

export { SOWELL_CATALOG_VOICE_ID };
export const SOWELL_PACK_SHA256 =
  "a9fa4422864e0048d035ead9ad6a304170f73aec409271903b05c9a789c7510d";
/** Cache identity. The pack hash is in it so another file cannot replay. */
export const SOWELL_CACHE_VARIANT = `sowell-kokoro82m-v1_0-${SOWELL_PACK_SHA256.slice(0, 12)}`;
/**
 * One HTTP call. Kokoro aims at 510 phonemes and can still emit 511.
 * That run is split so every phoneme is kept; a piece that would have to
 * drop text is still refused. Ordinary prose does not drop words (measured
 * at 2,699 characters). The book packer uses the same ceiling, so a section
 * is not a 280-character shard. A whole book still cannot be one call.
 */
export const SOWELL_MAX_CHARS = 2000;
/**
 * Default lanes for one book. Matches the deployed `max_containers`.
 * Raising {@link sowellBookLanes} does not start containers by itself.
 */
export const SOWELL_IN_FLIGHT = 2;
/**
 * Most lanes one book may ask for. The live fleet stays at
 * {@link SOWELL_IN_FLIGHT} until that env is set and the Modal class
 * cap is raised with it. Eight is four times the deployed fleet and
 * stays under the worker's global CPU admission.
 */
export const SOWELL_LANE_HARD_CEILING = 8;

/** Configured book lanes, clamped to the hard ceiling. Default is 2. */
export function sowellBookLanes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SOWELL_BOOK_LANES?.trim();
  const parsed = raw ? Number(raw) : SOWELL_IN_FLIGHT;
  const n = Number.isFinite(parsed) ? Math.floor(parsed) : SOWELL_IN_FLIGHT;
  return Math.min(SOWELL_LANE_HARD_CEILING, Math.max(1, n));
}

/**
 * Lanes for the sections still to speak. A book cannot use more
 * containers than it has sections: the 1,480-character acceptance book
 * had two sections, so a third container would have had nothing to run.
 * A longer book fills the configured cap and no more.
 */
export function planSowellLanes(input: {
  remainingSections: number;
  cap: number;
}): number {
  const cap = Math.min(
    SOWELL_LANE_HARD_CEILING,
    Math.max(1, Math.floor(input.cap) || 1)
  );
  const sections = Math.max(0, Math.floor(input.remainingSections) || 0);
  if (sections < 1) return 1;
  return Math.min(cap, sections);
}

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
