/**
 * Chapters for a document that has no trusted outline.
 *
 * EPUB nav, a PDF outline, and DOCX/HTML headings stay first, and only when
 * they validate. Everything else is decided from one pass of line features:
 * a contents page whose entries actually land on body lines, a layout score
 * (size, gaps, numbering), and the existing heading-line patterns as a
 * feature rather than the winner. A single leftover line is not a chapter.
 */

export interface LayoutLine {
  text: string;
  /** Zero-based page index. */
  page: number;
  /** Font height in PDF points. */
  size: number;
  /** 0 at the top of the page, 1 at the bottom. */
  y: number;
  bold?: boolean;
  centered?: boolean;
  /** Points of space above the line. */
  gapAbove?: number;
  /** First line on the page, or in the top band. */
  first?: boolean;
  /** About fifteen words of the following body line. */
  context?: string;
}

export interface LayoutFeatures {
  /** Character-weighted mode of line size. The body. */
  bodySize: number;
  pageCount: number;
  lines: LayoutLine[];
  /** Set by the optional verifier. Lines the model rejected. */
  rejectIds?: string[];
  /** Set by the optional verifier. Mid-score lines the model kept. */
  promoteIds?: string[];
}

export interface DetectedHeading {
  title: string;
  level: number;
  charStart: number;
  match: string;
}

export interface LayoutCandidate {
  id: string;
  text: string;
  page: number;
  score: number;
  high: boolean;
  /** Short feature list. The title is not rewritten from this. */
  features: string;
  context: string;
}

const MATTER_RE =
  /^(?:contents|table of contents|copyright|dedication|notes|endnotes|bibliography|references|works cited|index|about the author|about the authors|advertisement|also by the author)$/i;
const PART_RE =
  /^(?:book|part|volume)\s+(?:the\s+)?(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
const STRUCTURAL_RE = /^(?:chapter|part|book|volume|lecture|class|lesson)\b/i;
const CAPTION_RE = /^(?:fig(?:ure)?|table|plate)\b/i;
const PAGE_NUM_RE = /^(?:\d{1,4}|[ivxlcdm]{1,8})$/i;

const ACCEPT_SCORE = 5;
const HIGH_SCORE = 6;
const AMBIGUOUS_SCORE = 3;

type Prepared = LayoutLine & {
  id: string;
  ratio: number;
  score: number;
  numbered: boolean;
  structural: boolean;
  fromContents: boolean;
  /** Pulled back by a gap in a numbered run. Stays with that run's level. */
  recovered?: boolean;
};

export function foldHeading(value: string): string {
  return value
    .replace(/\u00ad/g, "")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬀ/g, "ff")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl")
    .replace(/(\p{L})-\s+(?=\p{L})/gu, "$1")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isMatterTitle(title: string): boolean {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (/^\d/.test(trimmed)) return false;
  const bare = trimmed.replace(/^(?:chapter|part|section)\s+\S+\s*[:.—-]?\s*/i, "").trim();
  return MATTER_RE.test(bare);
}

function numberDepth(text: string): number {
  const match = /^\s*(\d{1,3}(?:\.\d{1,2}){0,4})\b/.exec(text);
  if (!match?.[1]) return 0;
  return match[1].split(".").length;
}

function isPartLabel(text: string): boolean {
  return PART_RE.test(text.trim());
}

/**
 * A PDF outline, EPUB nav, or DOCX/HTML heading list is trusted only when it
 * is more than a handful of entries that all sit on the first page, or that
 * jump backwards through the book.
 */
export function trustedOutline(
  hint: {
    source: string;
    titles: { pageIndex?: number; charStart?: number }[];
  },
  spokenLength: number
): boolean {
  if (!["epub-spine", "pdf-outline", "docx-heading", "html-heading"].includes(hint.source)) {
    return false;
  }
  const pages = hint.titles
    .map((title) => title.pageIndex)
    .filter((page): page is number => typeof page === "number");
  if (pages.length >= 3) {
    if (pages.every((page) => page <= 0)) return false;
    let backwards = 0;
    for (let i = 1; i < pages.length; i++) {
      if (pages[i]! + 1 < pages[i - 1]!) backwards += 1;
    }
    if (backwards > Math.max(1, Math.floor(pages.length * 0.15))) return false;
  }
  const starts = hint.titles
    .map((title) => title.charStart)
    .filter((start): start is number => typeof start === "number");
  if (starts.length >= 3) {
    const inRange = starts.filter((start) => start >= 0 && start < spokenLength).length;
    if (inRange * 2 < starts.length) return false;
    let backwards = 0;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i]! < starts[i - 1]!) backwards += 1;
    }
    if (backwards > Math.max(1, Math.floor(starts.length * 0.15))) return false;
  }
  return true;
}

function repeatKey(line: LayoutLine): string {
  const bucket = Math.round((line.y || 0) * 20);
  const text = foldHeading(line.text).replace(/\d+/g, "#");
  return `${bucket}|${text}`;
}

function isFragment(text: string, ratio: number): boolean {
  const trimmed = text.trim();
  if (/^[a-z(]/.test(trimmed)) return true;
  if (/[,:;]$/.test(trimmed)) return true;
  if (trimmed.length > 100) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 18 && ratio < 1.25) return true;
  if (/[.!?]['"]?\s+\S/.test(trimmed)) return true;
  return false;
}

function mergeWrapped(lines: LayoutLine[]): LayoutLine[] {
  const out: LayoutLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const sameStyle =
      next &&
      next.page === line.page &&
      Math.abs(next.size - line.size) < 0.6 &&
      !/[.!?]$/.test(line.text.trim()) &&
      line.text.length <= 60 &&
      next.text.length <= 60 &&
      line.text.length + next.text.length <= 90 &&
      !PAGE_NUM_RE.test(next.text.trim()) &&
      !CAPTION_RE.test(next.text.trim());
    if (sameStyle && next) {
      out.push({ ...line, text: `${line.text.trim()} ${next.text.trim()}` });
      i += 1;
      continue;
    }
    out.push(line);
  }
  return out;
}

function dropNoise(lines: LayoutLine[], bodySize: number, pageCount: number): LayoutLine[] {
  const pagesOf = new Map<string, Set<number>>();
  for (const line of lines) {
    const key = repeatKey(line);
    const pages = pagesOf.get(key) ?? new Set<number>();
    pages.add(line.page);
    pagesOf.set(key, pages);
  }
  const repeated = new Set<string>();
  for (const [key, pages] of pagesOf) {
    if (pages.size >= 4 && pages.size >= Math.max(4, pageCount * 0.2)) repeated.add(key);
  }
  return lines.filter((line) => {
    const text = line.text.trim();
    if (!text) return false;
    if (repeated.has(repeatKey(line))) return false;
    if (PAGE_NUM_RE.test(text)) return false;
    if (CAPTION_RE.test(text)) return false;
    const ratio = bodySize > 0 ? line.size / bodySize : 1;
    if (bodySize > 0 && line.size < bodySize * 0.85) return false;
    if (isFragment(text, ratio)) return false;
    if (isMatterTitle(text)) return false;
    return true;
  });
}

function scoreLine(line: LayoutLine, bodySize: number): number {
  const ratio = bodySize > 0 ? line.size / bodySize : 1;
  const text = line.text.trim();
  let score = 0;
  if (ratio >= 1.35) score += 4;
  else if (ratio >= 1.18) score += 3;
  else if (ratio >= 1.08) score += 1;
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length <= 80 && words.length <= 14) score += 1;
  if (!/[.!?]$/.test(text)) score += 1;
  if ((line.gapAbove ?? 0) > Math.max(bodySize, line.size) * 0.6) score += 1;
  if (line.first) score += 1;
  if (line.bold) score += 1;
  if (line.centered) score += 1;
  if (numberDepth(text) >= 1 || /^\d{1,3}\b/.test(text)) score += 2;
  if (STRUCTURAL_RE.test(text)) score += 2;
  if (text.length <= 60 && text.length >= 3 && !/\p{Ll}/u.test(text) && /\p{L}/u.test(text)) {
    score += 1;
  }
  return score;
}

function prepare(layout: LayoutFeatures): Prepared[] {
  const bodySize = layout.bodySize > 0 ? layout.bodySize : 11;
  const merged = mergeWrapped(layout.lines);
  const cleaned = dropNoise(merged, bodySize, layout.pageCount);
  const reject = new Set(layout.rejectIds ?? []);
  const promote = new Set(layout.promoteIds ?? []);
  const prepared: Prepared[] = [];
  cleaned.forEach((line, index) => {
    const id = `p${line.page}-${index}`;
    if (reject.has(id)) return;
    const ratio = bodySize > 0 ? line.size / bodySize : 1;
    const numbered = numberDepth(line.text) >= 1 || /^\d{1,3}\s+\p{L}/u.test(line.text.trim());
    const structural = STRUCTURAL_RE.test(line.text.trim());
    let score = scoreLine(line, bodySize);
    if (promote.has(id) && score < ACCEPT_SCORE) score = ACCEPT_SCORE;
    prepared.push({
      ...line,
      id,
      ratio,
      score,
      numbered,
      structural,
      fromContents: false,
    });
  });
  return recoverSequence(prepared);
}

function recoverSequence(lines: Prepared[]): Prepared[] {
  const integers = new Map<number, Prepared>();
  for (const line of lines) {
    if (line.score < AMBIGUOUS_SCORE) continue;
    const match = /^(\d{1,3})\b/.exec(line.text.trim());
    if (!match) continue;
    if (numberDepth(line.text) !== 1) continue;
    const value = Number(match[1]);
    const current = integers.get(value);
    if (!current || line.score > current.score) integers.set(value, line);
  }
  const accepted = [...integers.entries()]
    .filter(([, line]) => line.score >= ACCEPT_SCORE)
    .map(([value]) => value)
    .sort((a, b) => a - b);
  if (accepted.length < 3) return lines;
  const missing: number[] = [];
  for (let value = accepted[0]!; value <= accepted[accepted.length - 1]!; value++) {
    if (!accepted.includes(value)) missing.push(value);
  }
  if (missing.length !== 1) return lines;
  const found = integers.get(missing[0]!);
  if (!found || found.score < AMBIGUOUS_SCORE) return lines;
  return lines.map((line) =>
    line.id === found.id ? { ...line, score: ACCEPT_SCORE, recovered: true } : line
  );
}

function contentsEntries(lines: LayoutLine[]): { title: string; printed: number; page: number }[] {
  const byPage = new Map<number, LayoutLine[]>();
  for (const line of lines) {
    const list = byPage.get(line.page) ?? [];
    list.push(line);
    byPage.set(line.page, list);
  }
  const contentsPages = new Set<number>();
  for (const [page, list] of byPage) {
    const parsed = list.filter((line) => parseContentsLine(line.text));
    if (parsed.length >= 3 && parsed.length >= list.length * 0.5) contentsPages.add(page);
  }
  if (contentsPages.size === 0) return [];
  const entries: { title: string; printed: number; page: number }[] = [];
  for (const line of lines) {
    if (!contentsPages.has(line.page)) continue;
    const parsed = parseContentsLine(line.text);
    if (!parsed || isMatterTitle(parsed.title)) continue;
    entries.push({ title: parsed.title, printed: parsed.printed, page: line.page });
  }
  return entries;
}

function parseContentsLine(text: string): { title: string; printed: number } | null {
  const trimmed = text.trim();
  const leaders = /^(.*?)(?:\.{2,}|…+)\s*(\d{1,4})\s*$/.exec(trimmed);
  const gap = leaders ?? /^(.*?)\s{2,}(\d{1,4})\s*$/.exec(trimmed);
  const plain = gap ?? /^(.*\D)\s+(\d{1,4})\s*$/.exec(trimmed);
  if (!plain?.[1] || !plain[2]) return null;
  const title = plain[1].replace(/[.\s]+$/g, "").trim();
  if (title.length < 2 || title.length > 90) return null;
  if (/^\d{3,4}\s*[-–—]\s*\d{3,4}$/.test(title)) return null;
  return { title, printed: Number(plain[2]) };
}

function similarTitle(a: string, b: string): boolean {
  const left = foldHeading(a);
  const right = foldHeading(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 8 && right.length >= 8 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  return false;
}

function contentsMatches(
  entries: { title: string; printed: number }[],
  body: Prepared[]
): { line: Prepared; title: string; depth: number }[] | null {
  if (entries.length < 4) return null;
  let bestRate = 0;
  let best: { line: Prepared; title: string; depth: number }[] = [];
  for (let offset = -4; offset <= 40; offset++) {
    const matched: { line: Prepared; title: string; depth: number }[] = [];
    const used = new Set<string>();
    for (const entry of entries) {
      const page = entry.printed + offset - 1;
      const line = body.find(
        (candidate) =>
          !used.has(candidate.id) &&
          Math.abs(candidate.page - page) <= 1 &&
          similarTitle(candidate.text, entry.title)
      );
      if (!line) continue;
      used.add(line.id);
      matched.push({ line, title: line.text.trim(), depth: Math.max(1, numberDepth(entry.title)) });
    }
    const rate = matched.length / entries.length;
    if (rate > bestRate) {
      bestRate = rate;
      best = matched;
    }
  }
  if (bestRate < 0.9) return null;
  return best;
}

function assignLevels(lines: Prepared[]): Map<string, number> {
  const parts = lines.filter((line) => isPartLabel(line.text));
  const chapterSizes = lines
    .filter((line) => !isPartLabel(line.text) && numberDepth(line.text) <= 1)
    .map((line) => line.size)
    .sort((a, b) => a - b);
  const topSize = chapterSizes.length
    ? chapterSizes[Math.floor(chapterSizes.length / 2)]!
    : 0;
  const levels = new Map<string, number>();
  for (const line of lines) {
    if (isPartLabel(line.text) || (line.recovered && numberDepth(line.text) <= 1)) {
      levels.set(line.id, 1);
      continue;
    }
    if (numberDepth(line.text) >= 2) {
      levels.set(line.id, 2);
      continue;
    }
    if (parts.length >= 2) {
      levels.set(line.id, 2);
      continue;
    }
    if (topSize > 0 && line.size < topSize * 0.92) {
      levels.set(line.id, 2);
      continue;
    }
    levels.set(line.id, 1);
  }
  return levels;
}

function locateLoose(haystack: string, needle: string): number {
  const trimmed = needle.trim();
  if (!trimmed) return -1;
  const exact = haystack.indexOf(trimmed);
  if (exact >= 0) return exact;
  const words = foldHeading(trimmed).split(" ").filter(Boolean);
  if (words.length === 0) return -1;
  const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(?:\\s|\\u00ad|-\\s*)+");
  const match = new RegExp(pattern, "i").exec(haystack);
  return match ? match.index : -1;
}

function anchorAt(
  spoken: string,
  pageStarts: number[],
  page: number,
  title: string,
  after: number
): number {
  const pageStart = pageStarts[page] ?? 0;
  const pageEnd = pageStarts[page + 1] ?? spoken.length;
  const from = Math.max(pageStart, after);
  const slice = spoken.slice(from, Math.max(pageEnd, from));
  const at = locateLoose(slice, title);
  if (at >= 0) return from + at;
  const rest = spoken.slice(Math.max(0, after));
  const wide = locateLoose(rest, title);
  if (wide >= 0) return Math.max(0, after) + wide;
  return Math.max(pageStart, after);
}

function toDetected(
  spoken: string,
  pageStarts: number[],
  rows: { title: string; level: number; page: number; match: string }[]
): DetectedHeading[] {
  const ordered = rows
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => a.page - b.page || a.index - b.index);
  let prev = -1;
  const placed: DetectedHeading[] = [];
  for (const row of ordered) {
    let charStart = anchorAt(spoken, pageStarts, row.page, row.match || row.title, prev + 1);
    if (charStart <= prev) charStart = Math.min(spoken.length - 1, prev + 1);
    if (charStart < 0 || charStart >= spoken.length) continue;
    prev = charStart;
    placed.push({
      title: row.title.replace(/\s+/g, " ").trim(),
      level: row.level,
      charStart,
      match: row.match,
    });
  }
  return placed;
}

function levelOne(lines: Prepared[], levels: Map<string, number>): Prepared[] {
  return lines.filter((line) => (levels.get(line.id) ?? 1) === 1);
}

function strongEnough(lines: Prepared[]): boolean {
  if (lines.length < 2 || lines.length > 200) return false;
  const strong = lines.filter(
    (line) => line.ratio >= 1.12 || line.numbered || line.structural || line.fromContents
  ).length;
  return strong / lines.length >= 0.6;
}

/**
 * Headings from layout features, or null when the page does not look like a
 * chapter list. Titles are the body lines themselves.
 */
export function detectLayoutChapters(
  spoken: string,
  layout: LayoutFeatures | undefined,
  pageStarts: number[] = []
): DetectedHeading[] | null {
  if (!layout || layout.lines.length === 0 || spoken.length === 0) return null;
  const prepared = prepare(layout);
  const entryList = contentsEntries(layout.lines);
  const contentsPages = new Set(entryList.map((entry) => entry.page));
  const body = prepared.filter((line) => !contentsPages.has(line.page));
  const matched = contentsMatches(entryList, body.length ? body : prepared);
  let chosen: Prepared[];
  if (matched) {
    chosen = matched.map((match) => ({
      ...match.line,
      text: match.title,
      fromContents: true,
      score: Math.max(match.line.score, ACCEPT_SCORE),
    }));
  } else {
    chosen = prepared.filter((line) => line.score >= ACCEPT_SCORE && !contentsPages.has(line.page));
  }
  if (chosen.length < 2) return null;
  const levels = assignLevels(chosen);
  const top = levelOne(chosen, levels);
  if (!matched && !strongEnough(top)) return null;
  if (matched && top.length < 2) return null;
  const rows = chosen.map((line) => ({
    title: line.text.trim(),
    level: levels.get(line.id) ?? 1,
    page: line.page,
    match: line.text.trim(),
  }));
  const detected = toDetected(spoken, pageStarts, rows);
  const topDetected = detected.filter((row) => row.level === 1);
  if (topDetected.length < 2) return null;
  return detected;
}

/** Mid-score lines the optional verifier may accept or reject. Titles stay put. */
export function layoutCandidateReport(layout: LayoutFeatures | undefined): {
  high: LayoutCandidate[];
  ambiguous: LayoutCandidate[];
} {
  if (!layout) return { high: [], ambiguous: [] };
  const prepared = prepare({ ...layout, rejectIds: undefined, promoteIds: undefined });
  const toCandidate = (line: Prepared): LayoutCandidate => ({
    id: line.id,
    text: line.text,
    page: line.page,
    score: line.score,
    high: line.score >= HIGH_SCORE,
    features: [
      `page ${line.page + 1}`,
      `ratio ${line.ratio.toFixed(2)}`,
      line.bold ? "bold" : "regular",
      line.first ? "page-top" : "mid-page",
      line.numbered ? "numbered" : "unnumbered",
    ].join(", "),
    context: (line.context ?? "").split(/\s+/).slice(0, 15).join(" "),
  });
  return {
    high: prepared.filter((line) => line.score >= HIGH_SCORE).map(toCandidate),
    ambiguous: prepared
      .filter((line) => line.score >= AMBIGUOUS_SCORE && line.score < HIGH_SCORE)
      .map(toCandidate),
  };
}

export interface HeadingScore {
  precision: number;
  recall: number;
  f1: number;
  exact: number;
  levelAccuracy: number;
  falsePer100Pages: number;
  predicted: number;
  truth: number;
}

export interface HeadingKey {
  title: string;
  page?: number;
  level?: number;
}

/** Precision and recall on (page, normalised title). */
export function scoreHeadings(
  predicted: HeadingKey[],
  truth: HeadingKey[],
  pageCount: number
): HeadingScore {
  const used = new Set<number>();
  let hits = 0;
  let exact = 0;
  let levels = 0;
  let levelCompared = 0;
  for (const row of predicted) {
    const folded = foldHeading(row.title);
    const index = truth.findIndex((item, itemIndex) => {
      if (used.has(itemIndex)) return false;
      if (foldHeading(item.title) !== folded) return false;
      if (row.page != null && item.page != null && row.page !== item.page) return false;
      return true;
    });
    if (index < 0) continue;
    used.add(index);
    hits += 1;
    if (row.title.trim() === truth[index]!.title.trim()) exact += 1;
    if (row.level != null && truth[index]!.level != null) {
      levelCompared += 1;
      if (row.level === truth[index]!.level) levels += 1;
    }
  }
  const none = predicted.length === 0 && truth.length === 0;
  const precision = predicted.length ? hits / predicted.length : truth.length ? 0 : 1;
  const recall = truth.length ? hits / truth.length : predicted.length ? 0 : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const pages = Math.max(1, pageCount);
  return {
    precision,
    recall,
    f1,
    exact: hits ? exact / hits : none ? 1 : 0,
    levelAccuracy: levelCompared ? levels / levelCompared : none ? 1 : 0,
    falsePer100Pages: ((predicted.length - hits) / pages) * 100,
    predicted: predicted.length,
    truth: truth.length,
  };
}

/**
 * Candidate lines for a laid-out PDF. Body prose is left out; the body size
 * is the character-weighted mode of every line.
 */
export function layoutFromPages(
  pages: {
    height: number;
    lines: {
      text: string;
      h: number;
      y: number;
      role?: "furniture";
      rule?: boolean;
      bold?: boolean;
      centered?: boolean;
      gapAbove?: number;
      pageTop?: boolean;
    }[];
  }[]
): LayoutFeatures {
  const weights = new Map<number, number>();
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.role === "furniture" || line.rule) continue;
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const key = Math.round(line.h * 2) / 2;
      weights.set(key, (weights.get(key) ?? 0) + text.length);
    }
  }
  let bodySize = 11;
  let best = 0;
  for (const [size, weight] of weights) {
    if (weight > best) {
      best = weight;
      bodySize = size;
    }
  }
  const lines: LayoutLine[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]!;
    let pending: LayoutLine | null = null;
    for (const line of page.lines) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text || line.role === "furniture" || line.rule) continue;
      const ratio = bodySize > 0 ? line.h / bodySize : 1;
      const numbered = /^\s*(?:\d{1,3}(?:\.\d{1,2}){0,3}|chapter|part|lecture|class|lesson)\b/i.test(
        text
      );
      const contents = /(?:\.{2,}|…+)\s*\d{1,4}\s*$/.test(text) || /\s{2,}\d{1,4}\s*$/.test(text);
      const short = text.length <= 80;
      const keep =
        ratio >= 1.12 ||
        numbered ||
        contents ||
        line.bold ||
        line.centered ||
        line.pageTop ||
        (line.gapAbove ?? 0) > line.h * 0.8 ||
        (short && line.pageTop);
      if (!keep) {
        if (pending && !pending.context) {
          pending.context = text.split(/\s+/).slice(0, 15).join(" ");
        }
        continue;
      }
      const record: LayoutLine = {
        text,
        page: pageIndex,
        size: line.h,
        y: page.height > 0 ? Math.min(1, Math.max(0, 1 - line.y / page.height)) : 0,
        ...(line.bold ? { bold: true } : {}),
        ...(line.centered ? { centered: true } : {}),
        ...(line.gapAbove != null ? { gapAbove: line.gapAbove } : {}),
        ...(line.pageTop ? { first: true } : {}),
      };
      lines.push(record);
      pending = record;
    }
  }
  let kept = lines;
  if (kept.length > 4000) {
    const early = kept.filter((line) => line.page < 15);
    const rest = kept
      .filter((line) => line.page >= 15)
      .sort((a, b) => b.size - a.size)
      .slice(0, Math.max(0, 4000 - early.length));
    kept = [...early, ...rest].sort((a, b) => a.page - b.page || a.y - b.y);
  }
  return { bodySize, pageCount: pages.length, lines: kept };
}
