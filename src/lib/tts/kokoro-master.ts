/**
 * Mastering inside the Kokoro container.
 *
 * A Kokoro take used to go provider → `raw/` → an `echomancer-cpu` task for
 * the podcast chain → `sections/NNNN.mp3`. That second app is one more cold
 * start, idle tail and object round trip per book. With
 * `KOKORO_CONTAINER_MASTER=1` the Kokoro request carries the recipe below and
 * the container returns the mastered MP3 next to the raw WAV
 * (`scripts/sowell/master.py`). The section is then published without a CPU
 * task. The section join is unchanged.
 *
 * The filter graphs are built here, by the same functions
 * `masterSectionBuffer` uses, so the two paths cannot drift: the container
 * only runs ffmpeg with these strings. If the container does not master (an
 * old deploy, a failed pass, a split section), the WAV goes through the CPU
 * task exactly as before.
 */
import {
  MASTER_OUTPUT_MP3_BITRATE,
  MASTER_OUTPUT_SAMPLE_RATE,
  SHORT_SECTION_GAIN_CLAMP_DB,
  SHORT_SECTION_MASTER_SECONDS,
  masterLoudnormAf,
  masterPreLoudnormAf,
  masterProfessionalAf,
  masterProfessionalMeasureAf,
  sectionLoudnessTarget,
} from "@/lib/tts/mastering";
import { shouldSectionMaster } from "@/lib/tts/section-master";

export const KOKORO_BUNDLE_CONTENT_TYPE = "application/x-echomancer-kokoro-bundle";

export type KokoroMasterRecipe = {
  measureAf: string;
  loudnorm: string;
  fallbackAf: string;
  preAf: string;
  targetI: number;
  targetTp: number;
  gainClampDb: number;
  shortSeconds: number;
  sampleRate: number;
  bitrate: string;
};

/** On when asked for, and only where the section would be mastered at all. */
export function kokoroContainerMasterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KOKORO_CONTAINER_MASTER !== "1") return false;
  return shouldSectionMaster(env);
}

/** The podcast chain, exactly as `masterSectionBuffer(…, "podcast")` runs it. */
export function kokoroMasterRecipe(env: NodeJS.ProcessEnv = process.env): KokoroMasterRecipe {
  const target = sectionLoudnessTarget("podcast");
  return {
    measureAf: masterProfessionalMeasureAf(env),
    loudnorm: masterLoudnormAf(),
    fallbackAf: masterProfessionalAf(env),
    preAf: masterPreLoudnormAf("podcast", env),
    targetI: target.i,
    targetTp: target.tp,
    gainClampDb: SHORT_SECTION_GAIN_CLAMP_DB,
    shortSeconds: SHORT_SECTION_MASTER_SECONDS,
    sampleRate: MASTER_OUTPUT_SAMPLE_RATE,
    bitrate: MASTER_OUTPUT_MP3_BITRATE,
  };
}

export type KokoroTake = { wav: Buffer; mastered?: Buffer };

/**
 * A plain `audio/wav` body, or the bundle: mastered MP3 then raw WAV, with
 * their lengths in `x-kokoro-mp3-bytes` / `x-kokoro-wav-bytes`. A bundle that
 * does not add up is an error, not a guess.
 */
export function parseKokoroBody(body: Buffer, headers: Headers): KokoroTake {
  const type = (headers.get("content-type") || "").split(";")[0]!.trim();
  if (type !== KOKORO_BUNDLE_CONTENT_TYPE) return { wav: body };
  const mp3 = Number(headers.get("x-kokoro-mp3-bytes"));
  const wav = Number(headers.get("x-kokoro-wav-bytes"));
  if (
    !Number.isInteger(mp3) ||
    !Number.isInteger(wav) ||
    mp3 < 0 ||
    wav < 44 ||
    mp3 + wav !== body.length
  ) {
    throw new Error("Kokoro bundle lengths do not match its body");
  }
  return {
    wav: body.subarray(mp3),
    ...(mp3 > 0 ? { mastered: body.subarray(0, mp3) } : {}),
  };
}
