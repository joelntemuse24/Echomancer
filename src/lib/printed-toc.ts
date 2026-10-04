/**
 * Printed contents page → chapter tree.
 *
 * Structural entries (Preface, Part, Chapter) match a later body heading.
 * Topic lines become children only when a placement is unique. A page
 * number maps through the offset of the parts that did match. A topic
 * with no number is placed only by a unique phrase in that part.
 * Anything else is dropped.
 */

import {
  CHAPTERS_VERSION,
  chapterDisplayTitle,
  headingLineMatches,
  type BookChapter,
  type ChapterHint,
  type ChaptersDocument,
} from "@/lib/book-chapters";

const YEAR_RE = /(\d{3,4})\s*[—–-]+\s*(\d{3,4})/;
const PART_RE =
  /^(?:part|book|chapter|volume|section)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
const MATTER_RE =
  /^(?:preface|introduction|foreword|prologue|epilogue|afterword|acknowledgements?)$/i;
const QUOTE_RE = /^[‘'"`“](.+?)[’'"`”]\s*(.*)$/;

const FUNCTION_WORDS = new Set(
  "a an the of and or to in on for by as at from with into over under its his her their was were been being that this these those than then them they you your our not but about after before between during without within against across per via".split(
    " "
  )
);

export interface TocTopic {
  title: string;
  printedPage?: number;
}

export interface TocEntry {
  /** Display label: "Part One", "Preface". */
  label: string;
  /** Source line used to find the body heading. */
  match: string;
  subtitle?: string;
  printedPage?: number;
  topics: TocTopic[];
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function norm(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-");
}

/** Join a pdf.js word that was split as "Am erican". Whole words stay apart. */
export function repairPdfWordSpaces(line: string): string {
  return line.replace(/([A-Za-z]{1,8}) ([a-z]{2,8})/g, (full, left: string, right: string) => {
    if (FUNCTION_WORDS.has(left.toLowerCase()) || FUNCTION_WORDS.has(right.toLowerCase())) {
      return full;
    }
    if (left.length > 4 && right.length > 3) return full;
    return left + right;
  });
}

function splitTrailingPage(line: string): { text: string; page?: number } {
  const trimmed = line.trim();
  if (!trimmed || YEAR_RE.test(trimmed)) return { text: clean(trimmed) };
  const leaders = /(?:\.{2,}|…+)\s*(\d{1,4})\s*$/.exec(trimmed);
  if (leaders) {
    return { text: clean(trimmed.slice(0, leaders.index)), page: Number(leaders[1]) };
  }
  const gap = /^(.+?)\s{2,}(\d{1,4})$/.exec(trimmed);
  if (gap && !YEAR_RE.test(gap[1] ?? "")) {
    return { text: clean(gap[1] ?? ""), page: Number(gap[2]) };
  }
  const labelled = /^((?:part|book|chapter|volume|section)\s+\S+)\s+(\d{1,4})$/i.exec(trimmed);
  if (labelled) return { text: clean(labelled[1] ?? ""), page: Number(labelled[2]) };
  return { text: clean(trimmed) };
}

function trailingPrintedPage(line: string): number | undefined {
  return splitTrailingPage(line).page;
}

function stripPage(line: string): string {
  return splitTrailingPage(line).text;
}

function isStructuralLabel(line: string): boolean {
  const t = clean(line);
  return MATTER_RE.test(t) || PART_RE.test(t);
}

/**
 * Title and era from the lead of a contents line or a glued paragraph.
 * "Huddled Masses and Crosses of Gold Industrial America, 1870—1912"
 * keeps the last two words before the year as the era.
 */
export function subtitleFromLead(text: string): string | undefined {
  const source = clean(text);
  const year = YEAR_RE.exec(source);
  if (!year || year.index == null || year.index > 220) return undefined;
  const rawBefore = source.slice(0, year.index).replace(/\s+$/g, "");
  const hadComma = /,\s*$/.test(rawBefore);
  const before = rawBefore.replace(/[,\s]+$/g, "").trim();
  if (!before) return undefined;
  const quoted = QUOTE_RE.exec(before);
  let title = "";
  let eraLead = "";
  if (quoted) {
    title = quoted[1]?.trim() ?? "";
    eraLead = quoted[2]?.trim() ?? "";
  } else {
    const words = before.split(/\s+/).filter(Boolean);
    if (words.length < 4) return undefined;
    eraLead = words.slice(-2).join(" ");
    title = words.slice(0, -2).join(" ");
  }
  if (!title) return undefined;
  const open = quoted ? source[0] : "";
  const close = quoted ? before.match(/[’'"`”]/)?.[0] ?? "'" : "";
  const printedTitle = quoted ? `${open}${title}${close}` : title;
  const era = clean(`${eraLead}${hadComma || eraLead.endsWith(",") ? "," : ""} ${year[0]}`).replace(
    /,\s*,/g,
    ","
  );
  return `${printedTitle} · ${era}`;
}

function topicTitle(line: string): string | null {
  let t = stripPage(line);
  const quoted = QUOTE_RE.exec(t);
  if (quoted && !quoted[2]?.trim()) t = quoted[1]?.trim() ?? t;
  if (!t || t.length > 120 || t.length < 3) return null;
  if (isStructuralLabel(t) || /^(?:contents|table of contents)$/i.test(t)) return null;
  // A quote that broke across a line ("TOO BAD!’ The Triumph…") is not a topic.
  if (/^[^‘'"`“]{0,24}[’'"`”]\s+\p{L}/u.test(t) && !QUOTE_RE.test(t)) return null;
  if (YEAR_RE.test(t) && t.length < 80) return null;
  if (/[.!?]\s+\p{Lu}/u.test(t) && t.length > 80) return null;
  return t;
}

/**
 * Parse a line-separated contents list. A glued paragraph still yields the
 * part's title and era; its topics stay unsplit.
 */
export function parsePrintedContents(lines: string[]): TocEntry[] {
  const cleaned = lines
    .map((line) => {
      const split = splitTrailingPage(line.replace(/\t/g, " "));
      const text = repairPdfWordSpaces(split.text).replace(/[ \t]+/g, " ").trim();
      if (!text) return "";
      return split.page != null ? `${text}  ${split.page}` : text;
    })
    .filter(Boolean);
  let start = cleaned.findIndex((line) => /^(?:contents|table of contents)$/i.test(line));
  if (start < 0) {
    start = cleaned.findIndex(
      (line, index) =>
        isStructuralLabel(line) &&
        (YEAR_RE.test(line) || YEAR_RE.test(cleaned[index + 1] ?? "") || YEAR_RE.test(cleaned[index + 2] ?? ""))
    );
  }
  if (start < 0) return [];
  const entries: TocEntry[] = [];
  let current: TocEntry | null = null;
  let pendingTitle: string | null = null;
  const pushTopic = (line: string) => {
    if (!current || line.length > 160) return;
    const topic = topicTitle(line);
    if (!topic) return;
    if (current.subtitle && norm(topic) === norm(current.subtitle.split(" · ")[0] ?? "")) return;
    const page = trailingPrintedPage(line);
    current.topics.push({
      title: topic,
      ...(page != null ? { printedPage: page } : {}),
    });
  };
  const flushPending = () => {
    if (pendingTitle) pushTopic(pendingTitle);
    pendingTitle = null;
  };
  const flush = () => {
    flushPending();
    if (current) entries.push(current);
    current = null;
  };
  for (let i = start; i < cleaned.length; i++) {
    const line = cleaned[i]!;
    if (/^(?:contents|table of contents)$/i.test(line)) continue;
    if (looksLikeNarration(line)) break;
    if (isStructuralLabel(line)) {
      flush();
      const page = trailingPrintedPage(line);
      const label = stripPage(line);
      current = {
        label: chapterDisplayTitle(label),
        match: label,
        ...(page != null ? { printedPage: page } : {}),
        topics: [],
      };
      continue;
    }
    if (!current) continue;
    if (!current.subtitle && current.topics.length === 0) {
      const combined = pendingTitle ? `${pendingTitle} ${line}` : line;
      const subtitle = subtitleFromLead(combined);
      if (subtitle) {
        current.subtitle = subtitle;
        pendingTitle = null;
        const year = YEAR_RE.exec(line);
        const rest = year ? clean(line.slice(year.index + year[0].length)) : "";
        if (rest.length > 80) continue;
        continue;
      }
      if (!pendingTitle && line.length < 100 && !/[.!?]\s+\p{Lu}/u.test(line)) {
        pendingTitle = stripPage(line);
        continue;
      }
    }
    flushPending();
    pushTopic(line);
  }
  flush();
  return entries.filter((entry) => entry.label.length > 0);
}

function paragraphSpans(spoken: string): { text: string; start: number }[] {
  const text = spoken.replace(/\r\n/g, "\n");
  const spans: { text: string; start: number }[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    spans.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  spans.push({ text: text.slice(start), start });
  return spans;
}

function looksLikeTopicDump(block: string): boolean {
  const t = clean(block);
  if (t.length < 180) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 12) return false;
  const cap = words.filter((word) => /^\p{Lu}/u.test(word)).length;
  const breaks = (t.match(/[.!?]\s+\p{Lu}/gu) || []).length;
  return cap / words.length >= 0.45 && breaks <= 3;
}

export function looksLikeNarration(block: string): boolean {
  const t = clean(block);
  if (looksLikeTopicDump(t)) return false;
  if (t.length < 80) return false;
  const breaks = (t.match(/[.!?]\s+\p{Lu}/gu) || []).length;
  if (breaks >= 2) return true;
  return breaks >= 1 && t.length >= 140;
}

/** A second copy of the same label is the body when prose follows it. */
export function isBodyHeadingBlock(blocks: string[], index: number): boolean {
  const here = clean(blocks[index] ?? "");
  if (looksLikeNarration(here)) return true;
  for (let j = index + 1; j < Math.min(blocks.length, index + 6); j++) {
    const next = clean(blocks[j] ?? "");
    if (!next) continue;
    if (isStructuralLabel(next)) return false;
    if (looksLikeTopicDump(next)) return false;
    if (looksLikeNarration(next)) return true;
    if (next.length > 220) return false;
  }
  return false;
}

function findBodySpan(
  spans: { text: string; start: number }[],
  entry: TocEntry,
  fromSpan: number
): number {
  const texts = spans.map((span) => clean(span.text));
  const hits: number[] = [];
  for (let i = fromSpan; i < spans.length; i++) {
    const para = texts[i] ?? "";
    if (!para) continue;
    if (headingLineMatches(para, entry.match) || headingLineMatches(para, entry.label)) {
      hits.push(i);
    }
  }
  for (const index of hits) {
    if (hits.length === 1 || isBodyHeadingBlock(texts, index)) return index;
  }
  return -1;
}

function paragraphStartNear(text: string, offset: number, window = 120): number {
  const from = Math.max(0, offset - window);
  const slice = text.slice(from, offset);
  const gap = slice.lastIndexOf("\n\n");
  if (gap < 0) return offset;
  const start = from + gap + 2;
  if (offset - start <= window) return start;
  return offset;
}

/** Lowercase, same length, so a hit offset is still a char offset in the source. */
function searchFold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-");
}

function findExact(haystack: string, phrase: string, from: number): number[] {
  const words = norm(phrase)
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length >= 2);
  if (words.length < 2 && (words[0]?.length ?? 0) < 8) return [];
  const body = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9']+");
  const re = new RegExp(`(?:^|[^a-z0-9])(${body})(?=[^a-z0-9]|$)`, "g");
  const folded = searchFold(haystack);
  const hits: number[] = [];
  re.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = re.exec(folded))) {
    const word = match[1] ?? "";
    const at = match.index + match[0].indexOf(word);
    hits.push(at);
    if (hits.length > 2) break;
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return hits;
}

/**
 * Unique verbatim placement of a topic inside one part. Quotes, dashes, and
 * case are folded. A partial word cluster is not a placement.
 */
export function placeTopicPhrase(partText: string, topic: string, from: number): number | null {
  const exact = findExact(partText, topic, from);
  return exact.length === 1 ? exact[0]! : null;
}

/** Re-find each PDF page in a later text. A short probe that misses stays at the cursor. */
export function locatePageStarts(text: string, probes: string[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const probe of probes) {
    const sample = probe.replace(/\s+/g, " ").trim();
    const needle = sample.slice(0, 32);
    if (needle.length < 16) {
      starts.push(cursor);
      continue;
    }
    const at = text.indexOf(needle, Math.max(0, cursor - 8));
    const pos = at >= 0 ? at : cursor;
    starts.push(pos);
    if (at >= 0) cursor = at + needle.length;
  }
  return starts;
}

/** Char offset of the body copy of a label. A contents-page copy is skipped. */
export function narratedHeadingOffset(text: string, label: string, from: number): number {
  const spans = paragraphSpans(text);
  let start = spans.length;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i]!.start >= from) {
      start = i;
      break;
    }
  }
  const at = findBodySpan(
    spans,
    { label, match: label, topics: [] },
    start
  );
  if (at < 0) return -1;
  return spans[at]!.start;
}

function pdfPageIndex(pageStarts: number[], offset: number): number {
  let page = 0;
  for (let i = 0; i < pageStarts.length; i++) {
    if (pageStarts[i]! <= offset) page = i;
    else break;
  }
  return page;
}

function snapPageOffset(text: string, pageStarts: number[], page: number): number | null {
  const start = pageStarts[page];
  if (start == null || start < 0 || start > text.length) return null;
  const end = pageStarts[page + 1] ?? text.length;
  const slice = text.slice(start, end);
  const gap = slice.search(/\S/);
  if (gap < 0) return null;
  const at = start + gap;
  return paragraphStartNear(text, at, 80);
}

function childChapter(
  title: string,
  charStart: number,
  parentEnd: number
): BookChapter {
  return {
    index: 0,
    title: clean(title).slice(0, 120),
    level: 2,
    charStart,
    charEnd: parentEnd,
  };
}

/**
 * Build a printed-toc chapter tree. Returns null when fewer than half of
 * the structural entries match a body heading.
 */
export function chaptersFromPrintedToc(
  spoken: string,
  hint?: Pick<ChapterHint, "tocLines" | "pageStarts">
): ChaptersDocument | null {
  const text = spoken.replace(/\r\n/g, "\n");
  if (!text.trim()) return null;
  const spans = paragraphSpans(text);
  const fromLines = hint?.tocLines?.length ? parsePrintedContents(hint.tocLines) : [];
  const fromBody = parsePrintedContents(spans.map((span) => clean(span.text)).slice(0, 80));
  const entries = fromLines.length >= 2 ? fromLines : fromBody;
  if (entries.length < 2) return null;

  const pageStarts = hint?.pageStarts;
  const chapters: BookChapter[] = [];
  const matched: TocEntry[] = [];
  let spanCursor = 0;
  const offsets: number[] = [];
  for (const entry of entries) {
    const at = findBodySpan(spans, entry, spanCursor);
    if (at < 0) continue;
    const span = spans[at]!;
    const subtitle =
      entry.subtitle ?? subtitleFromLead(clean(spans[at + 1]?.text ?? ""));
    if (pageStarts && entry.printedPage != null) {
      offsets.push(pdfPageIndex(pageStarts, span.start) - entry.printedPage);
    }
    chapters.push({
      index: chapters.length,
      title: entry.label,
      level: 1,
      charStart: span.start,
      charEnd: text.length,
      match: clean(span.text).slice(0, 180),
      ...(subtitle ? { subtitle } : {}),
    });
    matched.push(entry);
    spanCursor = at + 1;
  }
  if (chapters.length < 2 || chapters.length * 2 < entries.length) return null;

  const offset =
    offsets.length > 0
      ? offsets.slice().sort((a, b) => a - b)[Math.floor(offsets.length / 2)]!
      : null;

  for (let i = 0; i < chapters.length; i++) {
    const entry = matched[i];
    const next = chapters[i + 1]?.charStart ?? text.length;
    const partStart = chapters[i]!.charStart;
    const headingEnd = spans.find((span) => span.start === partStart);
    const searchFrom = headingEnd ? headingEnd.start + headingEnd.text.length : partStart;
    if (!entry || entry.topics.length === 0) {
      if (!chapters[i]!.subtitle && entry?.subtitle) chapters[i]!.subtitle = entry.subtitle;
      continue;
    }
    const children: BookChapter[] = [];
    let cursor = searchFrom;
    for (const topic of entry.topics) {
      let placed: number | null = null;
      if (topic.printedPage != null && pageStarts && offset != null) {
        const page = topic.printedPage + offset;
        const at = snapPageOffset(text, pageStarts, page);
        if (at != null && at >= searchFrom && at < next) placed = at;
      }
      if (placed == null) {
        const region = text.slice(cursor, next);
        const local = placeTopicPhrase(region, topic.title, 0);
        if (local == null) continue;
        placed = cursor + local;
      }
      if (placed < cursor || placed >= next) continue;
      const snapped = paragraphStartNear(text, placed);
      const charStart = snapped >= searchFrom && snapped < next ? snapped : placed;
      if (charStart < cursor) continue;
      children.push(childChapter(topic.title, charStart, next));
      cursor = Math.max(cursor, placed + topic.title.length);
    }
    for (let c = 0; c < children.length; c++) {
      children[c]!.index = c;
      children[c]!.charEnd = children[c + 1]?.charStart ?? next;
    }
    if (children.length > 0) chapters[i]!.children = children;
  }

  return {
    version: CHAPTERS_VERSION,
    source: "printed-toc",
    chapters,
  };
}
