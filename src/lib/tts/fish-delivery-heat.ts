/**
 * Whole-book and live-listen backstop for Fish stock twins.
 * Same warrant rules as the cue tagger: keep a shout when the sentence
 * clearly shouts, and remap hot cues on calm exposition.
 * The compare preview does not use this. It always remaps.
 */

import { isFishStockTwinCatalogId } from "@/lib/tts/fish-stock-twins";
import { restrainHotFishCues } from "@/lib/tts/fish-s2-cues";

export function applyExpressiveFishDelivery(
  text: string,
  providerId: string,
  catalogVoiceId?: string | null
): string {
  if (providerId !== "fish" || !isFishStockTwinCatalogId(catalogVoiceId)) {
    return text;
  }
  return restrainHotFishCues(text, "narration");
}
