/**
 * Fixed samples for narrator preview and Standard vs Expressive play-both.
 * The compare line is not the uploaded book. Fish compare keeps one
 * `[soft tone]` on the spoken line. Edge and Google keep the pause after
 * the title and strip emotion and tone.
 */

import { restrainHotFishCues, stripFishS2Cues } from "@/lib/tts/fish-s2-cues";
import {
  FISH_SOFT_TONE,
  narrationScriptForSynthesis,
} from "@/lib/tts/narration-script";
import { DELIVERY_COMPARE_TEXT, PREVIEW_TEXT } from "@/lib/tts/preview-text";
import {
  isChapterHeading,
  isSpeakableHeading,
} from "@/lib/tts/speakable-text";

export type DeliverySampleKind = "preview" | "compare";

/**
 * Exact text Fish s2.1-pro-free receives for Expressive compare / Play both
 * (Andrew, Michelle, Randolph). Ears-check this string.
 *
 * Chapter One
 *
 * [soft tone] The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."
 *
 * One allowlisted cue, on the spoken line. The two-word title stays plain.
 * Whole-book headings still use `[soft tone]` `[emphasis]` and `[long-break]`.
 */
export const FISH_COMPARE_SCRIPT = [
  "Chapter One",
  "",
  `${FISH_SOFT_TONE} The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."`,
].join("\n");

export function rawDeliverySample(sample: DeliverySampleKind): string {
  return sample === "compare" ? DELIVERY_COMPARE_TEXT : PREVIEW_TEXT;
}

/**
 * Compare-only. A short title stacked with `[soft tone]` `[emphasis]`
 * `[long-break]` (and any light emotion or effect cue) makes s2.1-pro-free
 * groan. Strip every square cue, then put a single `[soft tone]` on the
 * first spoken paragraph. A heading-only sample stays uncued.
 */
function softenFishCompareScript(script: string): string {
  const lines = stripFishS2Cues(script)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let placed = false;
  const out = lines.map((line) => {
    if (placed || isSpeakableHeading(line) || isChapterHeading(line)) {
      return line;
    }
    placed = true;
    return `${FISH_SOFT_TONE} ${line}`;
  });
  return out.join("\n\n");
}

/**
 * The plain one-liner is the short Edge / Google / Clara preview.
 * Expressive row preview and play-both pass `compare`. Edge / Google keep
 * the pause script (a beat after the title, no tone tags). Fish compare
 * is {@link FISH_COMPARE_SCRIPT}: one `[soft tone]` on the body, no effect
 * cues, no heading stack. Whole-book Expressive does not use this path
 * and may keep a warranted shout.
 */
export function scriptedDeliverySample(
  raw: string,
  providerId: string
): string {
  const script = narrationScriptForSynthesis(raw, providerId, {
    pauseStyle: "normal",
  });
  if (providerId !== "fish") return script;
  return softenFishCompareScript(restrainHotFishCues(script, "expressive"));
}

export function scriptDeliverySample(
  sample: DeliverySampleKind,
  providerId: string
): string {
  const raw = rawDeliverySample(sample);
  if (sample === "preview") return raw;
  return scriptedDeliverySample(raw, providerId);
}
