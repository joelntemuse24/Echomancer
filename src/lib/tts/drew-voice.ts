/**
 * Drew is a fine-tuned Kokoro-82M (StyleTTS2) model with its own full
 * kmodel weights and its own voice pack. It is not the Sowell/Walter pack,
 * not stock Kokoro `bm_george`, and not Edge `en-US-AndrewNeural`.
 *
 * The weights are private and are not in this repository. The Modal CPU app
 * reads them from the `andrew-distill` volume (see `modal/drew_worker.py`).
 *
 * **0.88 is Drew's native 1x.** The app sends 1.0 for natural pace and the
 * container multiplies by {@link DREW_NATIVE_KOKORO_SPEED} once. On the ONNX
 * graph that is only about 5–6% longer than Kokoro 1.0 (123.1 s versus
 * 116.4 s on a two-minute passage). Do not also lower `DREW_APP_SPEED_MAX`:
 * that would apply 0.88 twice. Style row 300 is unchanged.
 */

import {
  KOKORO_PRONUNCIATION_SUFFIX,
  kokoroPronunciationMismatch,
} from "@/lib/tts/kokoro-pronunciation";

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
/**
 * Pieces of one over-cap section that may run at once. A section is packed to
 * {@link DREW_MAX_CHARS}, so this is only reached by a hand-entered row; the
 * book-level lane count is in `sowell-voice.ts`.
 */
export const DREW_IN_FLIGHT = 2;

/**
 * Which checkpoint the takes came from. Part of the cache identity: a new
 * `stageA` step is a different model, so its audio must never be replayed
 * from a take recorded under this one. Bump with the volume paths.
 */
export const DREW_WEIGHTS_ID = "stageA-step00900";
/**
 * Tensor index pinned for every Drew chunk. Mirrors
 * `DREW_FIXED_STYLE_INDEX` in `scripts/sowell/drew.py`. The checkpoint
 * itself did not change; the cache key still moves, because a section
 * recorded under the length-indexed pack is a different take.
 * The key names the runtime and the Kokoro speed. `v2` stored the app speed
 * (still 1.0) while the container spoke 0.88, so an early worker deploy
 * would have cached the old pace under the new name, and an ONNX take
 * would have replayed on the torch graph. A section is stored only when
 * the response headers match this key.
 */
export const DREW_FIXED_STYLE_INDEX = 300;

/** Worker env. A custom key is readable; `{}` is the torch default. */
type KokoroEnv = NodeJS.ProcessEnv | { KOKORO_RUNTIME?: string; DREW_PROSODY_RULES?: string };

/** Worker env `KOKORO_RUNTIME`. Unset is torch, the same default as the image. */
export function drewRuntimeLabel(env: KokoroEnv = process.env): "onnx" | "torch" {
  return (env.KOKORO_RUNTIME ?? "").trim().toLowerCase() === "onnx" ? "onnx" : "torch";
}

/**
 * Take-home cache identity with the worker's runtime and native speed.
 * Prosody G, when on, is appended by {@link drewCacheVariant}.
 */
export function drewCacheIdentity(env: KokoroEnv = process.env): string {
  return `drew-kokoro82m-ft-${DREW_WEIGHTS_ID}-style${DREW_FIXED_STYLE_INDEX}-${drewRuntimeLabel(env)}-speed${DREW_NATIVE_KOKORO_SPEED.toFixed(3)}${KOKORO_PRONUNCIATION_SUFFIX}`;
}

/** Default key: torch, Kokoro speed 0.880, pronunciation lexicon. Tests and docs import this. */
export const DREW_CACHE_VARIANT = drewCacheIdentity({});
/**
 * Suffix while variant G is on. Mirrors `PROSODY_G_CACHE_SUFFIX` in
 * `scripts/sowell/prosody_rules.py`. A ruled take must not be replayed as
 * an unruled one. Bump both if the G constants change.
 */
export const DREW_PROSODY_G_SUFFIX = "-prosodyG";

/** Explicit on-values only. Unset, empty, and `0` leave Drew's forward stock. */
export function drewProsodyRulesEnabled(env: KokoroEnv = process.env): boolean {
  const raw = (env.DREW_PROSODY_RULES ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * The take-home cache identity. The suffix is present only while the flag
 * is on, so turning the flag off finds the takes recorded before it.
 */
export function drewCacheVariant(env: KokoroEnv = process.env): string {
  const base = drewCacheIdentity(env);
  if (!drewProsodyRulesEnabled(env)) return base;
  return `${base}${DREW_PROSODY_G_SUFFIX}`;
}

/**
 * Null when this response is the take the cache key names. A string is the
 * reason it must not be stored: the container's speed, runtime, or
 * pronunciation is not the one this worker will look up later.
 */
export function drewTakeMismatch(
  headers: { get(name: string): string | null },
  requestedSpeed: number,
  env: KokoroEnv = process.env
): string | null {
  const expectedSpeed = drewKokoroSpeed(requestedSpeed);
  const speedHeader = headers.get("x-kokoro-speed");
  const spoken = speedHeader == null ? Number.NaN : Number(speedHeader);
  if (!Number.isFinite(spoken) || Math.abs(spoken - expectedSpeed) > 0.0005) {
    return `Drew endpoint spoke at Kokoro speed ${speedHeader ?? "unknown"}, not ${expectedSpeed}. The audio was not stored.`;
  }
  const runtime = headers.get("x-kokoro-runtime");
  const expectedRuntime = drewRuntimeLabel(env);
  if (runtime !== expectedRuntime) {
    return `Drew endpoint runtime was ${runtime ?? "unknown"}, not ${expectedRuntime}. The audio was not stored.`;
  }
  return kokoroPronunciationMismatch(headers);
}

/** The request field, or nothing. Omitting it is how the container stays stock. */
export function drewProsodyField(env: KokoroEnv = process.env): "G" | undefined {
  return drewProsodyRulesEnabled(env) ? "G" : undefined;
}

/** Volume and object paths the operator must upload to, in one place. */
export const DREW_VOLUME_NAME = "andrew-distill";
export const DREW_VOLUME_MOUNT = "/andrew-distill";
export const DREW_KMODEL_PATH = "/kokoro/retrain_v3/stageA/step00900_kmodel.pth";
export const DREW_VOICE_PACK_PATH = "/kokoro/retrain_v3/stageA/step00900_voice.pt";

/**
 * Kokoro speed for a requested app speed. 1.0 becomes 0.88, and the result is
 * clamped to what the container accepts. The request path does not call
 * this; the container multiplies once.
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
