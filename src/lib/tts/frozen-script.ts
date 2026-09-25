/**
 * Freeze the take-home script once, then reuse it on every later tick.
 *
 * Re-running `toSpeakableText` + `splitTextForTts` on each claim can desync
 * stored `sections/NNNN.mp3` from the in-memory index. The first claim writes
 * `speakable.txt` and `sections.json` under the job prefix; later ticks load
 * those objects and synthesize `sections[i].text`.
 *
 * Fish / clone / Edge / Google Whole-book jobs freeze the cleaned speakable
 * before `packSpeakableSections`. Google Whole-book then packs against UTF-8 bytes
 * of the final SSML (`packProvider: "google"`), not raw speakable char count.
 */

import { downloadFile, fileExists, uploadFile } from "@/lib/storage";
import { evenTakehomeTargetChars } from "@/lib/tts/section-size";
import { packSpeakableSections } from "@/lib/tts/split-text";
import { playbackChaptersFromSections } from "@/lib/player/playback-chapters";
import {
  ensureListenPrep,
  ListenPrepDeferredError,
  logListenPrep,
  readListenPrepBest,
  readListenPrepCache,
  scheduleListenPrep,
} from "@/lib/tts/listen-prep-cache";
import {
  listenPrepChunkTimeoutMs,
  listenPrepPassWaitMs,
  prepareForListening,
  type ListenPrepFetch,
} from "@/lib/tts/listen-prep";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import {
  GOOGLE_SSML_HARD_MAX_BYTES,
  googleSynthesisSsmlUtf8Bytes,
} from "@/lib/tts/ssml-pauses";
import type { FrozenSection } from "@/lib/tts/types";

export const FROZEN_SPEAKABLE_NAME = "speakable.txt";
export const FROZEN_SECTIONS_NAME = "sections.json";
export const PLAYBACK_CHAPTERS_NAME = "playback-chapters.json";

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
  /**
   * Take-home Fish / clone: even-pack so `fanout` workers
   * get similar-sized slices. Skips `firstSectionMaxChars` when set.
   */
  evenFanout?: number;
  normalizeTitles?: boolean;
  /**
   * Whole-book Google packs against UTF-8 bytes of the final SSML.
   * Fish / Edge omit this and keep char-count packing.
   */
  packProvider?: string;
  /** `pdfs/<uploadId>/content.txt`, so a cleaned copy can be reused. */
  pdfStoragePath?: string | null;
  listenPrepFetch?: ListenPrepFetch;
  /** Absolute time the current tick or route must be finished. */
  deadlineMs?: number;
};

function tickBudgetLeft(deadlineMs: number | undefined): number | null {
  if (deadlineMs == null || !Number.isFinite(deadlineMs)) return null;
  const left = deadlineMs - Date.now();
  const headroom =
    left <= 12_000 ? Math.min(800, Math.floor(Math.max(0, left) * 0.1)) : left <= 60_000 ? 2_000 : 8_000;
  return Math.max(0, left - headroom);
}

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

function resolvePackChars(
  speakable: string,
  input: BuildFrozenScriptInput
): {
  maxChars: number;
  firstSectionMaxChars: number | undefined;
  evenFanout: number | undefined;
} {
  const evenFanout =
    typeof input.evenFanout === "number" &&
    Number.isFinite(input.evenFanout) &&
    input.evenFanout >= 1
      ? Math.floor(input.evenFanout)
      : undefined;
  if (evenFanout) {
    return {
      maxChars: evenTakehomeTargetChars(speakable.length, evenFanout),
      firstSectionMaxChars: undefined,
      evenFanout,
    };
  }
  return {
    maxChars: input.maxChars,
    firstSectionMaxChars: input.firstSectionMaxChars,
    evenFanout: undefined,
  };
}

function packFromSpeakable(
  speakable: string,
  input: BuildFrozenScriptInput
): FrozenScript {
  const pack = resolvePackChars(speakable, input);
  const google = input.packProvider === "google";
  const hardMaxChars = google
    ? Math.min(
        input.hardMaxChars ?? GOOGLE_SSML_HARD_MAX_BYTES,
        GOOGLE_SSML_HARD_MAX_BYTES
      )
    : input.hardMaxChars;
  const maxChars = google
    ? Math.min(pack.maxChars, hardMaxChars ?? GOOGLE_SSML_HARD_MAX_BYTES)
    : pack.maxChars;
  return {
    speakable,
    sections: packSpeakableSections(speakable, maxChars, {
      hardMaxChars,
      firstSectionMaxChars: pack.firstSectionMaxChars,
      measure: google ? googleSynthesisSsmlUtf8Bytes : undefined,
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

/** Section outline only. Does not download `speakable.txt`. */
export async function loadFrozenSectionOutline(
  jobId: string
): Promise<FrozenSection[] | null> {
  const sectionsPath = frozenSectionsPath(jobId);
  try {
    if (!(await fileExists(sectionsPath))) return null;
    const sectionsBuf = await downloadFile(sectionsPath);
    return parseFrozenSectionsJson(sectionsBuf.toString("utf8"));
  } catch {
    return null;
  }
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

export function playbackChaptersPath(jobId: string): string {
  return `${frozenScriptPrefix(jobId)}/${PLAYBACK_CHAPTERS_NAME}`;
}

function uploadIdFromContentPath(path: string | null | undefined): string | null {
  const match = path?.match(/^pdfs\/([^/]+)\/content\.txt$/);
  return match?.[1] ?? null;
}

/** First-claim path: clean the whole book, then pack and persist. */
export async function buildAndPersistFrozenScript(
  jobId: string,
  input: BuildFrozenScriptInput
): Promise<FrozenScript> {
  const uploadId = uploadIdFromContentPath(input.pdfStoragePath);
  let cleaned = input.rawText;
  if (uploadId) {
    const cached = await readListenPrepCache(uploadId, input.rawText);
    if (cached) {
      cleaned = cached.text;
      console.log(`[Job ${jobId}] listen-prep cached`);
    } else {
      const best = await readListenPrepBest(uploadId, input.rawText);
      if (best) {
        cleaned = best.text;
        if (!best.settled) scheduleListenPrep(uploadId);
        console.log(`[Job ${jobId}] listen-prep ${best.settled ? "cached" : "partial"}`);
      } else {
        const budget = tickBudgetLeft(input.deadlineMs);
        if (input.deadlineMs != null && (budget ?? 0) < listenPrepChunkTimeoutMs()) {
          throw new ListenPrepDeferredError();
        }
        const prep = await ensureListenPrep(uploadId, input.rawText, {
          fetch: input.listenPrepFetch,
          label: `Job ${jobId}`,
          waitMs: budget == null ? listenPrepPassWaitMs() : Math.min(listenPrepPassWaitMs(), budget),
          deadlineMs: input.deadlineMs,
        });
        if (prep?.text.trim()) {
          cleaned = prep.text;
        } else if (input.deadlineMs != null) {
          throw new ListenPrepDeferredError();
        } else {
          const local = await prepareForListening(input.rawText, {
            fetch: input.listenPrepFetch,
          });
          logListenPrep(`Job ${jobId}`, local);
          if (local.text.trim()) {
            cleaned = local.text;
          } else {
            console.error(
              `[Job ${jobId}] listen-prep produced no cleaned text; freezing the source`
            );
            cleaned = input.rawText;
          }
        }
      }
    }
  } else {
    const prep = await prepareForListening(input.rawText, {
      fetch: input.listenPrepFetch,
    });
    logListenPrep(`Job ${jobId}`, prep);
    cleaned = prep.text;
  }
  const speakable = toSpeakableText(cleaned, {
    normalizeTitles: input.normalizeTitles,
  });
  const built = packFromSpeakable(speakable, input);
  const pack = resolvePackChars(speakable, input);
  const first = built.sections[0]?.text.length ?? 0;
  const max = built.sections.reduce(
    (n, s) => Math.max(n, s.text.length),
    0
  );
  console.log(
    `[Job ${jobId}] pack evenFanout=${pack.evenFanout ?? "off"} sections=${built.sections.length} target=${pack.maxChars} first=${first} max=${max}`
  );
  await persistFrozenScript(jobId, built);
  const chapters = playbackChaptersFromSections(built.sections);
  await uploadFile(
    frozenScriptPrefix(jobId),
    PLAYBACK_CHAPTERS_NAME,
    Buffer.from(JSON.stringify({ chapters }), "utf8"),
    "application/json"
  ).catch((err) => {
    console.warn(
      `[Job ${jobId}] playback chapters skipped:`,
      err instanceof Error ? err.message : err
    );
  });
  return built;
}
