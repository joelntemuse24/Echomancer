/**
 * Drew is a fine-tuned Kokoro-82M (StyleTTS2) model with its own full
 * kmodel weights and its own voice pack. It is not the Sowell/Walter pack,
 * not stock Kokoro `bm_george`, and not Edge `en-US-AndrewNeural`.
 *
 * The weights are private and are not in this repository. The Modal CPU app
 * reads them from the `andrew-distill` volume (see `modal/drew_worker.py`).
 *
 * **0.88 is Drew's native 1x.** Real Andrew reads at that pace, so the app's
 * speed setting scales from there: request 1.0 renders at Kokoro speed 0.88,
 * request 1.1 renders at 0.968. Nothing else slows Drew down.
 */

export const DREW_CATALOG_VOICE_ID = "drew";
/** Provider-native id. The worker allowlists this one name only. */
export const DREW_PROVIDER_VOICE_ID = "drew";

/**
 * Kokoro speed that is Drew's natural reading pace. The worker multiplies
 * the requested speed by this value; it is never applied twice.
 */
export const DREW_NATIVE_KOKORO_SPEED = 0.88;
/** Same clamp the worker applies after the multiply. */
export const DREW_KOKORO_SPEED_MIN = 0.5;
export const DREW_KOKORO_SPEED_MAX = 2.0;

/**
 * One HTTP call. Kokoro aims at 510 phonemes, so the packer uses the same
 * 2,000-character ceiling as the other Kokoro voices.
 */
export const DREW_MAX_CHARS = 2000;
/** Same two containers as Sowell/Walter and George. Not a second fleet. */
export const DREW_IN_FLIGHT = 2;

/**
 * Which checkpoint the takes came from. Part of the cache identity: a new
 * `stageA` step is a different model, so its audio must never be replayed
 * from a take recorded under this one. Bump with the volume paths.
 */
export const DREW_WEIGHTS_ID = "stageA-step00900";
export const DREW_CACHE_VARIANT = `drew-kokoro82m-ft-${DREW_WEIGHTS_ID}-v1`;

/** Volume and object paths the operator must upload to, in one place. */
export const DREW_VOLUME_NAME = "andrew-distill";
export const DREW_VOLUME_MOUNT = "/andrew-distill";
export const DREW_KMODEL_PATH = "/kokoro/retrain_v3/stageA/step00900_kmodel.pth";
export const DREW_VOICE_PACK_PATH = "/kokoro/retrain_v3/stageA/step00900_voice.pt";

/**
 * Kokoro speed for a requested app speed. 0.88 is 1.0, and the result is
 * clamped to what the container accepts.
 */
export function drewKokoroSpeed(requested?: number | null): number {
  const base =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested
      : 1;
  const scaled = base * DREW_NATIVE_KOKORO_SPEED;
  return (
    Math.round(
      Math.min(DREW_KOKORO_SPEED_MAX, Math.max(DREW_KOKORO_SPEED_MIN, scaled)) *
        1000
    ) / 1000
  );
}

export function drewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DREW_ENABLED === "1";
}

export class DrewNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrewNotConfiguredError";
  }
}

/** The Modal endpoint, or a throw. Loopback is refused on the take-home VM. */
export function drewEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  if (!drewEnabled(env)) {
    throw new DrewNotConfiguredError("Drew is not enabled.");
  }
  const raw = env.DREW_URL?.trim() || "";
  if (!raw) throw new DrewNotConfiguredError("Drew is not configured (DREW_URL).");
  if (!env.DREW_TOKEN?.trim()) {
    throw new DrewNotConfiguredError("Drew is not configured (DREW_TOKEN).");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DrewNotConfiguredError("DREW_URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DrewNotConfiguredError("DREW_URL must be http or https.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new DrewNotConfiguredError("DREW_URL is the endpoint host, with no path.");
  }
  const host = url.hostname.toLowerCase();
  if (
    env.WORKER === "1" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  ) {
    throw new DrewNotConfiguredError("Drew synthesis on the take-home VM is refused.");
  }
  return url.origin;
}

export function drewReady(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    drewEndpoint(env);
    return true;
  } catch {
    return false;
  }
}
