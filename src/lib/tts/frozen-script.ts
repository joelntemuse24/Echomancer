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
import {
  chapterMatchList,
  resolveChapters,
  type BookChapter,
  type ChapterTitleHint,
  restoreProtectedHeadingBreaks,
} from "@/lib/book-chapters";
import { readUploadChapters } from "@/lib/uploads/chapters-store";
import { FISH_ACCOUNT_CONCURRENCY } from "@/lib/tts/fish-slots";
import {
  FIRST_SECTION_CHARS,
  FISH_HARD_MAX_CHARS,
  edgeGoogleTakehomeTargetChars,
  evenTakehomeTargetChars,
} from "@/lib/tts/section-size";
import { stripNarrationFrontMatter } from "@/lib/tts/front-matter";
import { absorbSmallFanoutRemainder, packSpeakableSections } from "@/lib/tts/split-text";
import {
  anchorChapterTree,
  playbackChaptersFromSections,
  playbackTreeFromCharStarts,
} from "@/lib/player/playback-chapters";
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

import { hasValidChapterStructure } from "@/lib/tts/chapter-choice";

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
  /** Clone section 1. Steady sections stay on `maxChars`. */
  secondSectionMaxChars?: number;
  /** Clone section 2. Section 3 onward stays on `maxChars`. */
  thirdSectionMaxChars?: number;
  /** Tighten section 1 once section 0 has closed on a sentence. */
  fitSecondSection?: (openingChars: number) => number;
  /** Tighten section 2 once section 0 and section 1 have closed. */
  fitThirdSection?: (openingChars: number, secondChars: number) => number;
  /**
   * Cap every section after the opening from the sections already closed.
   * The clone ramp stays under 2,000 characters until that row fits the
   * 1.5× buffer. When set, this wins over the fixed second and third caps.
   */
  fitNextSection?: (priorChars: number[]) => number;
  /**
   * Take-home Fish / clone: even-pack so `fanout` workers
   * get similar-sized slices. Section 0 still uses the fast first-section cap.
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
  secondSectionMaxChars: number | undefined;
  thirdSectionMaxChars: number | undefined;
  fitSecondSection: ((openingChars: number) => number) | undefined;
  fitThirdSection: ((openingChars: number, secondChars: number) => number) | undefined;
  fitNextSection: ((priorChars: number[]) => number) | undefined;
  evenFanout: number | undefined;
} {
  if (input.packProvider === "edge" || input.packProvider === "google") {
    return {
      maxChars: edgeGoogleTakehomeTargetChars(speakable.length, input.maxChars),
      firstSectionMaxChars: FIRST_SECTION_CHARS,
      secondSectionMaxChars: undefined,
      thirdSectionMaxChars: undefined,
      fitSecondSection: undefined,
      fitThirdSection: undefined,
      fitNextSection: undefined,
      evenFanout: 8,
    };
  }
  const evenFanout =
    typeof input.evenFanout === "number" &&
    Number.isFinite(input.evenFanout) &&
    input.evenFanout >= 1
      ? Math.floor(input.evenFanout)
      : undefined;
  if (evenFanout) {
    return {
      // Even packing sizes sections from the book length, which is the right
      // shape for parallel Fish workers but must never *raise* a caller's
      // ceiling: a clone book is packed to what one GPU call can render, and
      // ignoring `maxChars` here is what put four 4.2k sections into a book
      // sized for 2k ones (`job 12534aaa`, 2026-11-06).
      maxChars: Math.min(
        input.maxChars,
        evenTakehomeTargetChars(speakable.length, evenFanout)
      ),
      firstSectionMaxChars: FIRST_SECTION_CHARS,
      secondSectionMaxChars: undefined,
      thirdSectionMaxChars: undefined,
      fitSecondSection: undefined,
      fitThirdSection: undefined,
      fitNextSection: undefined,
      evenFanout,
    };
  }
  return {
    maxChars: input.maxChars,
    firstSectionMaxChars: input.firstSectionMaxChars ?? FIRST_SECTION_CHARS,
    secondSectionMaxChars: input.secondSectionMaxChars,
    thirdSectionMaxChars: input.thirdSectionMaxChars,
    fitSecondSection: input.fitSecondSection,
    fitThirdSection: input.fitThirdSection,
    fitNextSection: input.fitNextSection,
    evenFanout: undefined,
  };
}

function packFromSpeakable(
  speakable: string,
  input: BuildFrozenScriptInput,
  chapters?: { match: string; title: string }[]
): FrozenScript {
  const spoken = stripNarrationFrontMatter(speakable);
  const pack = resolvePackChars(spoken, input);
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
  let sections = packSpeakableSections(spoken, maxChars, {
    hardMaxChars,
    firstSectionMaxChars: pack.firstSectionMaxChars,
    secondSectionMaxChars: pack.secondSectionMaxChars,
    thirdSectionMaxChars: pack.thirdSectionMaxChars,
    fitSecondSection: pack.fitSecondSection,
    fitThirdSection: pack.fitThirdSection,
    fitNextSection: pack.fitNextSection,
    measure: google ? googleSynthesisSsmlUtf8Bytes : undefined,
    chapters,
  });
  if (input.evenFanout && input.packProvider !== "edge" && input.packProvider !== "google") {
    sections = absorbSmallFanoutRemainder(sections, {
      fanout: FISH_ACCOUNT_CONCURRENCY,
      hardMaxChars: hardMaxChars ?? FISH_HARD_MAX_CHARS,
    });
  }
  return {
    speakable: spoken,
    sections,
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

/** Rewrite `sections.json` without touching `speakable.txt`. */
export async function persistFrozenSections(
  jobId: string,
  sections: FrozenSection[]
): Promise<void> {
  await uploadFile(
    frozenScriptPrefix(jobId),
    FROZEN_SECTIONS_NAME,
    Buffer.from(JSON.stringify(sections), "utf8"),
    "application/json"
  );
}

/**
 * Split one frozen section that is wider than a call can finish.
 * Chapter identity stays with the parent. Indexes are assigned by the caller.
 */
export function splitWideFrozenSection(
  section: FrozenSection,
  maxChars: number
): FrozenSection[] {
  if (section.text.length <= maxChars) return [section];
  const parts = packSpeakableSections(section.text, maxChars, {
    skipFrontMatter: false,
    hardMaxChars: maxChars,
    firstSectionMaxChars: maxChars,
  }).filter((part) => part.text.length > 0);
  const slices =
    parts.length > 1
      ? parts
      : Array.from(
          { length: Math.ceil(section.text.length / maxChars) },
          (_, i) => ({ text: section.text.slice(i * maxChars, (i + 1) * maxChars) })
        );
  return slices.map((part) => ({
    ...section,
    text: part.text,
    chapterMarks: undefined,
  }));
}

/**
 * Replace the unpublished suffix with rows that fit `maxCharsFor`.
 *
 * A ready section keeps its index and its text, including when it sits
 * after a hole. Reindexing it would leave its audio on the old index.
 * Only the contiguous suffix after the last published index is split,
 * and that suffix starts at `fromIndex` when that is later.
 */
export function repackFrozenTail(
  sections: FrozenSection[],
  fromIndex: number,
  maxCharsFor: (section: FrozenSection, priorChars: number[]) => number,
  published: ReadonlySet<number> = new Set()
): FrozenSection[] {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const lastPublished = ordered.reduce(
    (max, section) => (published.has(section.index) ? Math.max(max, section.index) : max),
    -1
  );
  const tailStart = Math.max(fromIndex, lastPublished + 1);
  const kept = ordered.filter((section) => section.index < tailStart);
  const tail = ordered.filter((section) => section.index >= tailStart);
  const prior = kept.map((section) => section.text.length);
  const split: FrozenSection[] = [];
  for (const section of tail) {
    const parts = splitWideFrozenSection(section, maxCharsFor(section, prior));
    split.push(...parts);
    for (const part of parts) prior.push(part.text.length);
  }
  const nextIndex = kept.reduce((max, section) => Math.max(max, section.index), -1) + 1;
  return [
    ...kept,
    ...split.map((section, offset) => ({ ...section, index: nextIndex + offset })),
  ];
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

/** `speakable.txt` alone, or null when it is missing or empty. */
export async function loadFrozenSpeakable(jobId: string): Promise<string | null> {
  try {
    if (!(await fileExists(frozenSpeakablePath(jobId)))) return null;
    const spoken = (await downloadFile(frozenSpeakablePath(jobId))).toString("utf8");
    return spoken.trim() ? spoken : null;
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

/** Measured section starts written beside the playback chapters at finalize. */
export function sectionStartsPath(jobId: string): string {
  return `${frozenScriptPrefix(jobId)}/section-starts.json`;
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
  let chaptersDoc = uploadId ? await readUploadChapters(uploadId) : null;
  const hints = (nodes: BookChapter[]): ChapterTitleHint[] => nodes.flatMap((chapter) => [
    { title: chapter.title, level: chapter.level, anchors: [chapter.match ?? chapter.title] },
    ...hints(chapter.children ?? []),
  ]);
  const offline = resolveChapters(input.rawText, {
    source: chaptersDoc?.source ?? "heading-lines",
    titles: hints(chaptersDoc?.chapters ?? []),
  });
  if (!chaptersDoc || (!hasValidChapterStructure(input.rawText, chaptersDoc) &&
      hasValidChapterStructure(input.rawText, offline))) chaptersDoc = offline;
  const chapterPairs =
    chaptersDoc && chaptersDoc.chapters.length > 0
      ? chapterMatchList(chaptersDoc)
      : undefined;
  const protect = chapterPairs != null;
  let cleaned = input.rawText;
  if (uploadId) {
    const cached = await readListenPrepCache(uploadId, input.rawText, { protect });
    if (cached) {
      cleaned = cached.text;
      console.log(`[Job ${jobId}] listen-prep cached`);
    } else {
      const best = await readListenPrepBest(uploadId, input.rawText, { protect });
      if (best) {
        cleaned = best.text;
        if (!best.settled) scheduleListenPrep(uploadId);
        console.log(`[Job ${jobId}] listen-prep ${best.settled ? "cached" : "partial"}`);
      } else if (!input.rawText.trim()) {
        cleaned = input.rawText;
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
          protect,
        });
        if (prep?.text.trim()) {
          cleaned = prep.text;
        } else if (input.deadlineMs == null) {
          const local = await prepareForListening(input.rawText, {
            fetch: input.listenPrepFetch,
            protect: chapterPairs?.map((chapter) => chapter.match),
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
        } else {
          console.error(
            `[Job ${jobId}] listen-prep produced no cleaned text; freezing the source`
          );
          cleaned = input.rawText;
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
  if (chapterPairs?.length) {
    cleaned = restoreProtectedHeadingBreaks(
      cleaned,
      chapterPairs.map((chapter) => chapter.match)
    );
  }
  const speakable = toSpeakableText(cleaned, {
    normalizeTitles: input.normalizeTitles,
  });
  const built = packFromSpeakable(speakable, input, chapterPairs);
  const pack = resolvePackChars(built.speakable, input);
  const first = built.sections[0]?.text.length ?? 0;
  const max = built.sections.reduce(
    (n, s) => Math.max(n, s.text.length),
    0
  );
  console.log(
    `[Job ${jobId}] pack evenFanout=${pack.evenFanout ?? "off"} sections=${built.sections.length} target=${pack.maxChars} first=${first} max=${max}`
  );
  await persistFrozenScript(jobId, built);
  const anchored = chaptersDoc
    ? anchorChapterTree(chaptersDoc.chapters, built.speakable)
    : [];
  const chapters =
    anchored.length > 0
      ? playbackTreeFromCharStarts(anchored, built.speakable.length)
      : playbackChaptersFromSections(built.sections);
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
