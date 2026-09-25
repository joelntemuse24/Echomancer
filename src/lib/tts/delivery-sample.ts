/**
 * Fixed samples for narrator preview and Standard vs Expressive play-both.
 * The compare line is not the uploaded book. Fish receives the words only.
 * Edge and Google keep the pause after the title and strip emotion and tone.
 */

import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { DELIVERY_COMPARE_TEXT, PREVIEW_TEXT } from "@/lib/tts/preview-text";

export type DeliverySampleKind = "preview" | "compare";

/**
 * Exact text Fish s2.1-pro-free receives for Expressive compare / Play both
 * (Andrew, Michelle, Randolph). No square-bracket cues.
 *
 * Chapter One.
 *
 * The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."
 */
export const FISH_COMPARE_SCRIPT = [
  "Chapter One.",
  "",
  'The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."',
].join("\n");

export function rawDeliverySample(sample: DeliverySampleKind): string {
  return sample === "compare" ? DELIVERY_COMPARE_TEXT : PREVIEW_TEXT;
}

/**
 * The plain one-liner is the short Edge / Google / Clara preview.
 * Expressive row preview and play-both pass `compare`. Edge / Google keep
 * the pause script (a beat after the title, no tone tags). Fish compare
 * is {@link FISH_COMPARE_SCRIPT}: the heading and the spoken line, no cues.
 */
export function scriptedDeliverySample(
  raw: string,
  providerId: string
): string {
  if (providerId === "fish") {
    return narrationScriptForSynthesis(raw, "fish");
  }
  return narrationScriptForSynthesis(raw, providerId, {
    pauseStyle: "normal",
  });
}

export function scriptDeliverySample(
  sample: DeliverySampleKind,
  providerId: string
): string {
  const raw = rawDeliverySample(sample);
  if (sample === "preview") return raw;
  return scriptedDeliverySample(raw, providerId);
}
