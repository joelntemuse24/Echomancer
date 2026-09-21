/**
 * Freeze the take-home script once, then reuse it on every later tick.
 *
 * Re-running `toSpeakableText` + `splitTextForTts` on each claim can desync
 * stored `sections/NNNN.mp3` from the in-memory index. The first claim writes
 * `speakable.txt` and `sections.json` under the job prefix; later ticks load
 * those objects and synthesize `sections[i].text`.
 *
 * Fish / clone / Edge / Google Whole-book jobs optionally run **one logical**
 * OpenRouter cue-tag pass (paragraph-chunked, parallel) before
 * `packSpeakableSections`.
 */

import { downloadFile, fileExists, uploadFile } from "@/lib/storage";
import {
  tagFishCuesForSpeakable,
  type CueTaggerFetch,
} from "@/lib/tts/fish-cue-tagger";
import { packSpeakableSections } from "@/lib/tts/split-text";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import type { FrozenSection } from "@/lib/tts/types";

export const FROZEN_SPEAKABLE_NAME = "speakable.txt";
export const FROZEN_SECTIONS_NAME = "sections.json";

export type FrozenScript = {
  speakable: string;
  sections: FrozenSection[];
  rebuilt: boolean;
};

export type BuildFrozenScriptInput = {
  rawText: string;
  maxChars: number;
  hardMaxChars?: number;
  firstSectionMaxChars?: number;
  normalizeTitles?: boolean;
  /**
   * Whole-book Fish / Edge / Google: one logical OpenRouter cue-tag pass
   * on the speakable before the chapter packer runs. Long books are
   * chunked and tagged in parallel. OpenRouter / Gemini / Grok leave this
   * unset (they would speak the tags).
   */
  tagFishCues?: boolean;
  cueTaggerFetch?: CueTaggerFetch;
};

export function frozenScriptPrefix(jobId: string): string {
  return `audiobooks/${jobId}`;
}

export function frozenSpeakablePath(jobId: string): string {
  return `${frozenScriptPrefix(jobId)}/${FROZEN_SPEAKABLE_NAME}`;
}

export function frozenSectionsPath(jobId: string): string {
  return `${frozenScriptPrefix(jobId)}/${FROZEN_SECTIONS_NAME}`;
}

function isFrozenSection(value: unknown): value is FrozenSection {
  if (!value || typeof value !== "object") return false;
  const s = value as FrozenSection;
  return (
    typeof s.index === "number" &&
    typeof s.text === "string" &&
    typeof s.chapterIndex === "number" &&
    typeof s.charStart === "number" &&
    typeof s.charEnd === "number"
  );
}

export function parseFrozenSectionsJson(raw: string): FrozenSection[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const sections = parsed.filter(isFrozenSection).sort((a, b) => a.index - b.index);
    if (sections.length !== parsed.length) return null;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i]!.index !== i) return null;
      if (!sections[i]!.text.trim()) return null;
    }
    return sections;
  } catch {
    return null;
  }
}

function packFromSpeakable(
  speakable: string,
  input: BuildFrozenScriptInput
): FrozenScript {
  return {
    speakable,
    sections: packSpeakableSections(speakable, input.maxChars, {
      hardMaxChars: input.hardMaxChars,
      firstSectionMaxChars: input.firstSectionMaxChars,
    }),
    rebuilt: true,
  };
}

export function buildFrozenScript(input: BuildFrozenScriptInput): FrozenScript {
  const speakable = toSpeakableText(input.rawText, {
    normalizeTitles: input.normalizeTitles,
  });
  return packFromSpeakable(speakable, input);
}

export async function persistFrozenScript(
  jobId: string,
  script: Pick<FrozenScript, "speakable" | "sections">
): Promise<void> {
  const prefix = frozenScriptPrefix(jobId);
  await uploadFile(
    prefix,
    FROZEN_SPEAKABLE_NAME,
    Buffer.from(script.speakable, "utf8"),
    "text/plain; charset=utf-8"
  );
  await uploadFile(
    prefix,
    FROZEN_SECTIONS_NAME,
    Buffer.from(JSON.stringify(script.sections), "utf8"),
    "application/json"
  );
}

export async function loadFrozenScript(
  jobId: string
): Promise<FrozenScript | null> {
  const sectionsPath = frozenSectionsPath(jobId);
  try {
    if (!(await fileExists(sectionsPath))) return null;
    const sectionsBuf = await downloadFile(sectionsPath);
    const sections = parseFrozenSectionsJson(sectionsBuf.toString("utf8"));
    if (!sections) return null;

    let speakable = sections.map((s) => s.text).join("\n\n");
    try {
      if (await fileExists(frozenSpeakablePath(jobId))) {
        const spoken = (await downloadFile(frozenSpeakablePath(jobId))).toString(
          "utf8"
        );
        if (spoken.trim()) speakable = spoken;
      }
    } catch {
      /* sections.json is enough to synthesize */
    }

    return { speakable, sections, rebuilt: false };
  } catch {
    return null;
  }
}

/**
 * Load the frozen script, or rebuild and persist it once if the objects
 * are missing or unreadable.
 */
export async function loadOrBuildFrozenScript(
  jobId: string,
  input: BuildFrozenScriptInput
): Promise<FrozenScript> {
  const existing = await loadFrozenScript(jobId);
  if (existing) return existing;
  return buildAndPersistFrozenScript(jobId, input);
}

/** First-claim path: cue-tag (optional) → pack → persist. */
export async function buildAndPersistFrozenScript(
  jobId: string,
  input: BuildFrozenScriptInput
): Promise<FrozenScript> {
  const speakable = toSpeakableText(input.rawText, {
    normalizeTitles: input.normalizeTitles,
  });
  const tagged = input.tagFishCues
    ? await tagFishCuesForSpeakable(speakable, {
        fetch: input.cueTaggerFetch,
      })
    : speakable;
  if (input.tagFishCues) {
    console.log(
      `[Job ${jobId}] cue-tag pass ${tagged === speakable ? "fail-open/untagged" : "applied"} chars=${speakable.length}`
    );
  }
  const built = packFromSpeakable(tagged, input);
  await persistFrozenScript(jobId, built);
  return built;
}
