/**
 * Fixed samples for narrator preview and Standard vs Expressive play-both.
 * The compare line is not the uploaded book. Fish keeps cue tags; Edge and
 * Google strip emotion and tone at this same narration-script step.
 */

import { restrainHotFishCues } from "@/lib/tts/fish-s2-cues";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { DELIVERY_COMPARE_TEXT, PREVIEW_TEXT } from "@/lib/tts/preview-text";

export type DeliverySampleKind = "preview" | "compare";

export function rawDeliverySample(sample: DeliverySampleKind): string {
  return sample === "compare" ? DELIVERY_COMPARE_TEXT : PREVIEW_TEXT;
}

/**
 * The plain one-liner is the short Edge / Google / Clara preview.
 * Expressive row preview and play-both pass `compare`, which runs this
 * narration script so Fish keeps cue tags and Edge / Google strip them.
 */
/**
 * Compare-line narration script. Fish keeps allowlisted cues, then hot
 * tones (`shouting`, `screaming`, `hysterical`, `extremely excited`) are
 * remapped to calm / soft tone / emphasis / curious so the sample stays
 * more alive than Edge without a shout.
 */
export function scriptedDeliverySample(
  raw: string,
  providerId: string
): string {
  const script = narrationScriptForSynthesis(raw, providerId, {
    pauseStyle: "normal",
  });
  if (providerId !== "fish") return script;
  return restrainHotFishCues(script, "expressive");
}

export function scriptDeliverySample(
  sample: DeliverySampleKind,
  providerId: string
): string {
  const raw = rawDeliverySample(sample);
  if (sample === "preview") return raw;
  return scriptedDeliverySample(raw, providerId);
}
