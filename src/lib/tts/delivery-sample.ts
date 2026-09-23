/**
 * Fixed samples for narrator preview and Standard vs Expressive play-both.
 * The compare line is not the uploaded book. Fish compare keeps one
 * `[confident]` on the spoken line. Edge and Google keep the pause after
 * the title and strip emotion and tone.
 */

import { restrainHotFishCues, stripFishS2Cues } from "@/lib/tts/fish-s2-cues";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { DELIVERY_COMPARE_TEXT, PREVIEW_TEXT } from "@/lib/tts/preview-text";
import {
  isChapterHeading,
  isSpeakableHeading,
} from "@/lib/tts/speakable-text";

export type DeliverySampleKind = "preview" | "compare";

/**
 * Official Fish S2 emotion. Assertive clear speech.
 * `[soft tone]` is the lullaby cue (gentle, quiet) and s2.1-pro-free turns
 * that into breaths on this short sample. Do not put it on the compare line.
 */
const FISH_COMPARE_CUE = "[confident]";

/**
 * Exact text Fish s2.1-pro-free receives for Expressive compare / Play both
 * (Andrew, Michelle, Randolph). Ears-check this string.
 *
 * Chapter One
 *
 * [confident] The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."
 *
 * One allowlisted cue, on the spoken line. No soft tone, whisper, sigh, or
 * pause tag. The two-word title stays plain. Whole-book headings use
 * `[confident]` and `[long-break]`, not `[soft tone]`.
 */
export const FISH_COMPARE_SCRIPT = [
  "Chapter One",
  "",
  `${FISH_COMPARE_CUE} The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."`,
].join("\n");

export function rawDeliverySample(sample: DeliverySampleKind): string {
  return sample === "compare" ? DELIVERY_COMPARE_TEXT : PREVIEW_TEXT;
}

/**
 * Compare-only. A short title stacked with tone tags, pauses, or effect
 * cues makes s2.1-pro-free groan or breathe. Strip every square cue, then
 * put a single `[confident]` on the first spoken paragraph. A heading-only
 * sample stays uncued. Whole-book headings use the same `[confident]` cue.
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
    return `${FISH_COMPARE_CUE} ${line}`;
  });
  return out.join("\n\n");
}

/**
 * The plain one-liner is the short Edge / Google / Clara preview.
 * Expressive row preview and play-both pass `compare`. Edge / Google keep
 * the pause script (a beat after the title, no tone tags). Fish compare
 * is {@link FISH_COMPARE_SCRIPT}: one `[confident]` on the body, no soft
 * tone, no effect cues, no heading stack. Whole-book Expressive does not
 * use this path and may keep a warranted shout.
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
