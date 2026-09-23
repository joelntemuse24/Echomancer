/**
 * Expressive stock twins (Andrew, Michelle, Randolph) never speak a hot
 * Fish cue. Clara and user clones keep narration-mode restraint inside the
 * cue tagger, which still allows a shout when the dialogue clearly warrants it.
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
  return restrainHotFishCues(text, "expressive");
}
