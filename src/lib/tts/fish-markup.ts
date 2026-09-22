/**
 * Read the frozen Whole-book script and the exact Fish `text` field.
 *
 * Does not tag, pack, or synthesize. `speakable.txt` / `sections.json` are
 * written once on the first take-home claim; this only loads them.
 *
 * `storedText` is the cue-tagged window in `sections.json`. `fishText` is
 * what `synthesizeSection` passes as Fish `text` (pause-script rewrite on
 * that window). Other request fields (`reference_id`, speed, latency) are
 * not part of either string.
 */

import { fileExists } from "@/lib/storage";
import {
  deliveryUserInputFromUnknown,
  resolveDeliverySettings,
  type PauseStyle,
} from "@/lib/tts/delivery-settings";
import {
  frozenSpeakablePath,
  loadFrozenScript,
} from "@/lib/tts/frozen-script";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import type { FrozenSection } from "@/lib/tts/types";

export type FishMarkupSection = {
  index: number;
  chapterIndex: number;
  chapterTitle: string | null;
  /** Exact `sections.json` text for this window. */
  storedText: string;
  /**
   * Exact Fish `text` body for this window.
   * Null when the job provider is not `fish`.
   */
  fishText: string | null;
};

export type FishMarkup = {
  jobId: string;
  provider: string;
  /** True when `fishText` is the string Fish receives. */
  fishBound: boolean;
  pauseStyle: PauseStyle;
  deliveryPrefix: boolean;
  /** `speakable.txt` when that object exists; otherwise sections joined. */
  speakableSource: "speakable.txt" | "sections";
  speakable: string;
  sections: FishMarkupSection[];
};

export type OwnedMarkupJob = {
  id: string;
  tts_provider: string | null;
  tts_options: string | null;
};

function parseTtsOptions(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function fishRequestText(
  sectionText: string,
  providerId: string,
  pauseStyle: PauseStyle,
  deliveryPrefix: boolean
): string | null {
  if (providerId !== "fish") return null;
  return narrationScriptForSynthesis(sectionText, "fish", {
    deliveryPrefix,
    pauseStyle: pauseStyle === "sparse" ? "sparse" : "normal",
  });
}

function toSection(
  section: FrozenSection,
  providerId: string,
  pauseStyle: PauseStyle,
  deliveryPrefix: boolean
): FishMarkupSection {
  return {
    index: section.index,
    chapterIndex: section.chapterIndex,
    chapterTitle: section.chapterTitle,
    storedText: section.text,
    fishText: fishRequestText(
      section.text,
      providerId,
      pauseStyle,
      deliveryPrefix
    ),
  };
}

/**
 * Load stored markup for a job the caller already owns.
 * Returns null when the freeze has not been written yet.
 */
export async function loadStoredFishMarkup(
  job: OwnedMarkupJob
): Promise<FishMarkup | null> {
  const frozen = await loadFrozenScript(job.id);
  if (!frozen) return null;

  const provider = job.tts_provider || "";
  const delivery = resolveDeliverySettings(
    frozen.speakable,
    deliveryUserInputFromUnknown(parseTtsOptions(job.tts_options))
  );
  const speakablePath = frozenSpeakablePath(job.id);
  let speakableSource: FishMarkup["speakableSource"] = "sections";
  try {
    if (await fileExists(speakablePath)) speakableSource = "speakable.txt";
  } catch {
    speakableSource = "sections";
  }

  return {
    jobId: job.id,
    provider,
    fishBound: provider === "fish",
    pauseStyle: delivery.pauseStyle,
    deliveryPrefix: delivery.deliveryPrefix,
    speakableSource,
    speakable: frozen.speakable,
    sections: frozen.sections.map((section) =>
      toSection(
        section,
        provider,
        delivery.pauseStyle,
        delivery.deliveryPrefix
      )
    ),
  };
}
