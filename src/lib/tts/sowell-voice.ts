/**
 * Walter (internal id `sowell`) is a separate Kokoro-82M voice pack. It is
 * not a stock Edge voice and it is not a Fish clone. The pack is not in the
 * web bundle. Synthesis is an HTTP call to the Modal CPU app. The take-home
 * VM does not run it.
 *
 * The id stays `sowell` so stored books, saved picks, and
 * `public/voice-previews/sowell.mp3` keep working; only the listed name moved
 * to Walter. The customer-facing error strings say Walter for that reason.
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
 * Pieces of one over-cap section run at most this many at a time. A section
 * is packed to {@link SOWELL_MAX_CHARS}, so this is only reached by a
 * hand-entered or legacy row; it stays at two so a split section cannot
 * take lane capacity from the sections behind it.
 */
export const SOWELL_PIECE_IN_FLIGHT = 2;
/**
 * Default lanes for one book. Matches the deployed `max_containers` of the
 * `echomancer-sowell` app (`SOWELL_MAX_CONTAINERS`, also 16).
 *
 * This is the cap on **one** book. The Modal fleet holds 16 containers, and
 * the `kokoro` provider-slot rows are the cross-process share of them, so
 * several books from different users cannot open more than sixteen concurrent
 * Kokoro calls between them on torch. ONNX multiplies that by the streams
 * in each container ({@link sowellCallCap}). `SOWELL_BOOK_LANES` overrides
 * this per process.
 */
export const SOWELL_IN_FLIGHT = 16;
/**
 * Most calls one book may ask for on the torch fleet. One call is one
 * container. ONNX serves four calls in each container, so its ceiling is
 * {@link SOWELL_ONNX_CALL_CEILING}.
 */
export const SOWELL_LANE_HARD_CEILING = 16;
/** Calls one ONNX container serves when `KOKORO_STREAMS` is unset. */
export const SOWELL_ONNX_STREAMS_DEFAULT = 4;
/**
 * Concurrent Kokoro calls on a full ONNX fleet: 16 containers × 4 streams.
 * Twelve containers are 48. Torch stays at one call per container.
 */
export const SOWELL_ONNX_CALL_CEILING = 64;
/**
 * Fleet-wide ceiling on concurrent Kokoro calls, shared by every worker
 * process. It is the deployed `max_containers`, so the fleet is not
 * over-subscribed. `SOWELL_MAX_CONTAINERS` is the same knob the Modal class
 * reads; this is the worker's copy of it. A 429 from a busy container is
 * still handled, so a mis-set value degrades rather than fails.
 */
export const SOWELL_FLEET_CONTAINERS_DEFAULT = 16;
export const SOWELL_FLEET_CONTAINERS_CEILING = 16;

/** Deployed container count. Clamped to 1..{@link SOWELL_FLEET_CONTAINERS_CEILING}. */
export function sowellFleetContainers(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.SOWELL_MAX_CONTAINERS?.trim();
  const parsed = raw ? Number(raw) : SOWELL_FLEET_CONTAINERS_DEFAULT;
  const n = Number.isFinite(parsed)
    ? Math.floor(parsed)
    : SOWELL_FLEET_CONTAINERS_DEFAULT;
  return Math.min(SOWELL_FLEET_CONTAINERS_CEILING, Math.max(1, n));
}

/** True when this worker is pointed at the ONNX image. Unset is torch. */
export function kokoroRuntimeIsOnnx(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KOKORO_RUNTIME ?? "").trim().toLowerCase() === "onnx";
}

/**
 * Calls one container serves. Torch is 1. ONNX is 4 unless
 * `KOKORO_STREAMS_PER_CONTAINER` names another count in 1..8.
 */
export function sowellStreamsPerContainer(env: NodeJS.ProcessEnv = process.env): number {
  if (!kokoroRuntimeIsOnnx(env)) return 1;
  const raw = env.KOKORO_STREAMS_PER_CONTAINER?.trim();
  const parsed = raw ? Number(raw) : SOWELL_ONNX_STREAMS_DEFAULT;
  const n = Number.isFinite(parsed) ? Math.floor(parsed) : SOWELL_ONNX_STREAMS_DEFAULT;
  if (n < 1) return SOWELL_ONNX_STREAMS_DEFAULT;
  return Math.min(8, n);
}

/**
 * Concurrent Kokoro calls the fleet can serve.
 *
 * Torch: one call per container, so the cap is the container count (16).
 * ONNX: containers × streams, 48 at 12 containers and 64 at 16.
 */
export function sowellCallCap(env: NodeJS.ProcessEnv = process.env): number {
  const containers = sowellFleetContainers(env);
  if (!kokoroRuntimeIsOnnx(env)) return containers;
  return Math.min(
    SOWELL_ONNX_CALL_CEILING,
    containers * sowellStreamsPerContainer(env)
  );
}

/**
 * Configured book lanes, clamped to the call cap. Torch never asks for more
 * than one call per container. ONNX may ask for every stream in the fleet.
 */
export function sowellBookLanes(env: NodeJS.ProcessEnv = process.env): number {
  const cap = sowellCallCap(env);
  const raw = env.SOWELL_BOOK_LANES?.trim();
  const fallback = kokoroRuntimeIsOnnx(env) ? cap : SOWELL_IN_FLIGHT;
  const parsed = raw ? Number(raw) : fallback;
  const n = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(cap, Math.max(1, n));
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
    throw new SowellNotConfiguredError("Walter is not enabled.");
  }
  const raw = env.SOWELL_URL?.trim() || "";
  if (!raw) throw new SowellNotConfiguredError("Walter is not configured (SOWELL_URL).");
  if (!env.SOWELL_TOKEN?.trim()) {
    throw new SowellNotConfiguredError("Walter is not configured (SOWELL_TOKEN).");
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
      "Walter synthesis on the take-home VM is refused."
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
