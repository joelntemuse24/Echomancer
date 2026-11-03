/**
 * Layout-aware page furniture on pdf.js text items.
 *
 * A line is furniture only when it sits in the top or bottom band of a page
 * and it is a page number that agrees with the page index, or the same
 * letters-only line repeats at that position on at least three pages.
 * A line that appears once is kept. A repeated edge line is a running head
 * when it sits outside the body block. The block comes from the modal line
 * spacing, so a stanza break does not widen it. Font size protects a line
 * only when it is an outlier in its group. A chapter, lecture, or letter
 * heading is kept unless that exact line repeats at the head position.
 */

import { isLayoutHeadingLine } from "@/lib/tts/speakable-text";

export type PdfTextItem = {
  k: number;
  s: string;
  eol: boolean;
  x: number;
  y: number;
  h: number;
  /**
   * The glyphs run at an angle to the page. A publisher's DOI banner down the
   * side margin is rotated; body text never is.
   */
  rotated?: boolean;
};

export type PdfLine = {
  y: number;
  h: number;
  items: PdfTextItem[];
  text: string;
  role?: "furniture";
  why?: string;
  /** Distance to the next line toward the body. Set before body lines are dropped. */
  gap?: number;
  /** Every glyph on this line is rotated. */
  rotated?: boolean;
  /**
   * The line is a drawing rule or carries no letters — an underscore rule under
   * a running head, a dot leader, a bare pipe. It is never prose, so it must not
   * be treated as the edge of the body block.
   */
  rule?: boolean;
};

export type PdfPage = {
  height: number;
  items: PdfTextItem[];
  lines: PdfLine[];
  /** Item-order text. Edge lines point at `lines`; body lines are inlined. */
  flow?: Array<{ text: string; line: PdfLine | null }>;
  bodyH?: number;
  spacing?: number;
  /** y of the first and last line of the modal-spaced body block. */
  bodyTop?: number;
  bodyBot?: number;
};

export type FurnitureBlock = {
  page: number;
  text: string;
  role: "body" | "furniture";
  label: string;
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (opts: { scale: number }) => { height: number };
    getTextContent: () => Promise<{ items: unknown[] }>;
    cleanup?: () => void;
  }>;
};

const normKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/^[\W\d_]*\b[ivxlcdm]{1,7}\b\.?\s+/i, "")
    .replace(/[^a-z]/g, "");

function ratio(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const BARE_STRUCTURAL =
  /^(?:chapters?|parts?|books?|lectures?|letters?|acts?|scenes?|cantos?|staves?|sections?)$/i;
const NUMBERED_STRUCTURAL =
  /^(?:chapters?|parts?|books?|lectures?|letters?|acts?|scenes?|cantos?|staves?|sections?)\s+[\divxlcdm]+\b/i;

/** A heading word with no number, such as a two-line "Chapter" / "1". */
export function isBareStructuralHeading(text: string): boolean {
  return BARE_STRUCTURAL.test(text.trim().replace(/[.:,;]+$/g, ""));
}

/** "Lecture I", "Letter 1", "Chapter 3". Kept unless that exact line repeats. */
export function isNumberedStructuralHeading(text: string): boolean {
  return NUMBERED_STRUCTURAL.test(text.trim());
}

function romanValue(text: string): number | null {
  const t = text.trim().replace(/^[^\w]+|[^\w]+$/g, "").toUpperCase();
  if (!/^[IVXLCDM]{1,7}$/.test(t)) return null;
  const value: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = value[t[i]!] ?? 0;
    const next = value[t[i + 1]!] ?? 0;
    n += cur < next ? -cur : cur;
  }
  return n > 0 ? n : null;
}

/** Most common gap in the normal line-spacing range. Stanza breaks do not vote. */
function modeGap(gaps: number[]): number {
  const hist = new Map<number, number>();
  for (const gap of gaps) {
    if (gap < 8 || gap > 36) continue;
    const bin = Math.round(gap);
    hist.set(bin, (hist.get(bin) || 0) + 1);
  }
  let best = 0;
  let count = 0;
  for (const [bin, n] of hist) {
    if (n > count || (n === count && bin < best)) {
      best = bin;
      count = n;
    }
  }
  return best || 14;
}

/**
 * Body block from lines joined by the modal spacing. A margin line whose
 * gap is more than 2pt over that spacing stays outside the block.
 *
 * A drawing rule does not vote. A running head sits under an underscore rule
 * with about one line of space between them, so counting that gap as ordinary
 * spacing lets the header join the body — and then `bodyTop` *is* the header's
 * y, so nothing downstream can tell it is furniture. Rules are skipped when the
 * spacing is measured and when the block's edges are taken.
 */
function measureBody(page: PdfPage): { bodyH: number; spacing: number; top: number; bot: number } {
  const lines = [...page.lines].sort((a, b) => b.y - a.y);
  const prose = lines.filter((line) => !line.rule);
  const raw: number[] = [];
  for (let i = 1; i < prose.length; i++) {
    const gap = prose[i - 1]!.y - prose[i]!.y;
    if (gap > 0) raw.push(gap);
  }
  const spacing = modeGap(raw);
  const joins = (gap: number) => gap <= spacing + 2;
  const linked = new Set<PdfLine>();
  for (let i = 0; i < prose.length; i++) {
    const prev = i > 0 ? prose[i - 1]!.y - prose[i]!.y : Infinity;
    const next = i + 1 < prose.length ? prose[i]!.y - prose[i + 1]!.y : Infinity;
    if ((i > 0 && joins(prev)) || (i + 1 < prose.length && joins(next))) linked.add(prose[i]!);
  }
  let used = prose.filter((line) => linked.has(line));
  if (!used.length) {
    const inner = prose.filter((_, index) => index > 0 && index < prose.length - 1);
    const detachedHead = prose.length >= 2 && prose[0]!.y - prose[1]!.y > spacing + 2;
    used = inner.length ? inner : detachedHead ? prose.slice(1) : prose;
  }
  return {
    bodyH: median(used.map((line) => line.h)) || 11,
    spacing,
    top: used[0]?.y ?? page.height,
    bot: used[used.length - 1]?.y ?? 0,
  };
}

function gapTowardBody(lines: PdfLine[], index: number): number {
  const line = lines[index]!;
  // A rule has no reading position of its own, so the gap is measured to the
  // nearest line that carries words.
  if (line.rule) {
    const below = lines.slice(index + 1).find((row) => !row.rule);
    const above = lines.slice(0, index).reverse().find((row) => !row.rule);
    if (below) return line.y - below.y;
    if (above) return above.y - line.y;
    return line.y;
  }
  // The next line toward the body, skipping rules on the way.
  const step = index < lines.length - 1 - index ? 1 : -1;
  for (let i = index + step; i >= 0 && i < lines.length; i += step) {
    if (lines[i]!.rule) continue;
    return step === 1 ? line.y - lines[i]!.y : lines[i]!.y - line.y;
  }
  return line.y;
}

/**
 * A structural heading set larger than the body gets a break before and
 * after it, so a later unwrap keeps the label on its own paragraph.
 */
export function stampTallHeadings(page: PdfPage): void {
  if (page.lines.length < 2) return;
  const heights = page.lines.map((line) => line.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 11;
  const itemBefore = new Map<number, PdfTextItem>();
  for (let i = 1; i < page.items.length; i++) {
    itemBefore.set(page.items[i]!.k, page.items[i - 1]!);
  }
  for (const line of page.lines) {
    if (line.h < median * 1.35) continue;
    if (!isLayoutHeadingLine(line.text)) continue;
    const first = line.items[0];
    const last = line.items[line.items.length - 1];
    if (!first || !last) continue;
    const prev = itemBefore.get(first.k);
    if (prev) prev.eol = true;
    last.eol = true;
  }
}

/**
 * Drop item payloads. Keep the visual lines plus item-order text.
 *
 * `flow` is the narration order, and every segment points at the line it
 * belongs to. That matters because a furniture pass can mark *any* line on the
 * page, not only an edge one: a publisher's licence banner stamped in the middle
 * of the page is invisible to the edge bands, so pointing only at edge lines
 * would let a pass mark it and change nothing.
 *
 * The line records themselves stay (without their items), because the chapter
 * pass needs each line's text and height to tell a heading from body text — and
 * re-reading a 2,800-page document to get that back is more than the whole
 * extract costs.
 */
export function compactPage(page: PdfPage): PdfPage {
  const stats = measureBody(page);
  const edge = new Set<PdfLine>([
    ...page.lines.slice(0, 2),
    ...page.lines.slice(Math.max(0, page.lines.length - 2)),
  ]);
  page.lines.forEach((line, index) => {
    if (edge.has(line)) line.gap = gapTowardBody(page.lines, index);
  });
  const lineOf = new Map<number, PdfLine>();
  for (const line of page.lines) for (const item of line.items) lineOf.set(item.k, line);
  const flow: Array<{ text: string; line: PdfLine | null }> = [];
  for (const item of page.items) {
    const line = lineOf.get(item.k) ?? null;
    const piece = item.s + (item.eol ? "\n" : "");
    const last = flow[flow.length - 1];
    if (last && last.line === line) last.text += piece;
    else flow.push({ text: piece, line });
  }
  for (const line of page.lines) line.items = [];
  return {
    height: page.height,
    items: [],
    lines: page.lines,
    flow,
    bodyH: stats.bodyH,
    spacing: stats.spacing,
    bodyTop: stats.top,
    bodyBot: stats.bot,
  };
}

/** Group pdf.js items into visual lines. Item order on the page is preserved. */
/**
 * A line that is a drawing rule rather than text.
 *
 * An underscore rule under a running head joins the header into the body block:
 * the modal spacing links them, `bodyTop` becomes the header's own y, and
 * `outsideBody()` then says "not above the body". NIST's report carries the same
 * banner and the same rule on 490 pages, so the header survives 490 times.
 *
 * A rule is never prose, so it cannot vote on where the body starts or ends.
 *
 * The test is a *repeated* rule character, not merely "no letters". A stray `+`
 * or `–` is a real glyph: GPT-3's citations read `[VSP+17]`, and the plus is set
 * on its own line by the extractor. Dropping it silently corrupts the text.
 * A page number is not a rule either — digits still read.
 */
export function isRuleOrEmptyLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/\p{L}/u.test(t) || /\p{N}/u.test(t)) return false;
  // Underscores, dashes, dots, equals, asterisks, pipes: three or more of the
  // same drawing character, possibly with spaces between them.
  return /^([_=~*·•.…|\\/\u2013\u2014-])(?:\s*\1){2,}$/u.test(t);
}

export function pageFromItems(
  items: PdfTextItem[],
  height: number
): PdfPage {
  const vis = items.filter((item) => item.s.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const item of vis) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - item.y) < Math.max(3, 0.5 * Math.min(line.h, item.h))) {
      line.items.push(item);
      line.h = Math.max(line.h, item.h);
    } else {
      lines.push({ y: item.y, h: item.h, items: [item], text: "" });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.map((item) => item.s).join(" ").replace(/\s+/g, " ").trim();
    line.rotated = line.items.length > 0 && line.items.every((item) => item.rotated);
    line.rule = isRuleOrEmptyLine(line.text);
  }
  return { height, items, lines };
}

export async function extractPdfPages(pdf: PdfDoc): Promise<PdfPage[]> {
  const pages: PdfPage[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.flatMap((raw, k) => {
      if (!raw || typeof raw !== "object" || !("str" in raw) || typeof raw.str !== "string") return [];
      const transform = "transform" in raw && Array.isArray(raw.transform) ? raw.transform : [];
      const height = "height" in raw && typeof raw.height === "number" ? raw.height : 10;
      const yScale = typeof transform[3] === "number" ? transform[3] : 0;
      // A run whose glyphs are not level with the page. Body text is set
      // horizontally; a publisher's DOI banner down the side margin is not.
      const skew = Math.abs(typeof transform[1] === "number" ? transform[1] : 0);
      return [{
        k,
        s: raw.str,
        eol: "hasEOL" in raw && Boolean(raw.hasEOL),
        x: typeof transform[4] === "number" ? transform[4] : 0,
        y: typeof transform[5] === "number" ? transform[5] : 0,
        h: Math.abs(yScale) || height || 10,
        ...(skew > 0.5 ? { rotated: true } : {}),
      }];
    });
    const laid = pageFromItems(items, viewport.height);
    stampTallHeadings(laid);
    pages.push(compactPage(laid));
    page.cleanup?.();
  }
  return pages;
}

/**
 * True when a line is set apart from the text below (top) or above (bottom) it:
 * a gap wider than normal leading, or a drawing rule in between.
 *
 * A page's genuine first line is often a heading sitting directly above its
 * paragraph at normal leading, and that must stay body. A running head is either
 * separated by a gap or underlined by a rule.
 */
function edgeIsSetApart(page: PdfPage, line: PdfLine, docSpacing: number): boolean {
  const at = page.lines.indexOf(line);
  const towardBody = at === 0 ? page.lines.slice(1) : page.lines.slice(0, at).reverse();
  for (const row of towardBody) {
    if (row.rule) return true;
    if (row.rotated) continue;
    const gap = Math.abs(line.y - row.y);
    return gap > docSpacing + 2;
  }
  return false;
}

/**
 * Mark margin lines. A running head needs the same letters on at least
 * three pages. A one-off line, including a chapter title, stays body.
 */
export function markFurniture(
  pages: PdfPage[],
  opts: { band?: number; minRepeat?: number; fuzz?: number } = {}
): FurnitureBlock[] {
  const band = opts.band ?? 0.2;
  const minRepeat = opts.minRepeat ?? 3;
  const fuzz = opts.fuzz ?? 0.8;
  /**
   * Repeated this many times, always as a page's own first or last line, a
   * group is a running head or foot whatever the body block says.
   *
   * `outsideBody` compared a line to the modal body top, which is only as
   * reliable as `measureBody`. When a rule merged the header into the block,
   * `typicalTop` *became* the header's y and every copy looked like body. A
   * banner that is the first thing on five pages is furniture by construction,
   * so it no longer has to win that comparison.
   */
  const alwaysEdge = new Set<string>();
  const measured = pages.map((page) =>
    page.flow && page.bodyTop != null && page.bodyBot != null
      ? { bodyH: page.bodyH || 11, spacing: page.spacing || 14, top: page.bodyTop, bot: page.bodyBot }
      : measureBody(page)
  );
  const docBodyH = median(measured.map((row) => row.bodyH)) || 11;
  const docSpacing = modeGap(measured.map((row) => row.spacing).filter((gap) => gap >= 8 && gap <= 36)) || 14;
  const slack = 4;
  const full = measured.filter((row) => row.top - row.bot >= 4 * docSpacing);
  const basis = full.length ? full : measured;
  const windowMode = (vals: number[]) => {
    let best = vals[0] ?? 0;
    let cnt = -1;
    for (const v of vals) {
      const n = vals.filter((w) => Math.abs(w - v) <= slack).length;
      if (n > cnt) {
        cnt = n;
        best = v;
      }
    }
    const near = vals.filter((w) => Math.abs(w - best) <= slack).sort((a, b) => a - b);
    return near[Math.floor(near.length / 2)] ?? best;
  };
  const typicalTop = windowMode(basis.map((row) => row.top));
  const typicalBot = windowMode(basis.map((row) => row.bot));
  // Above the usual block, or below both the usual block and this page's own
  // spacing-linked block (a long page's extra last line stays body). A group
  // that is always the page's first or last line is furniture regardless.
  const outsideBody = (cand: (typeof cands)[number]) => {
    const own = measured[cand.pi]!;
    const above = cand.L.y > typicalTop + slack;
    const below =
      cand.L.y < typicalBot - slack &&
      (cand.L.y < own.bot - 0.5 || cand.L.y < typicalBot - 2 * docSpacing - slack);
    return above || below || alwaysEdge.has(`${cand.pos}:${cand.key}`);
  };
  const cands: Array<{ pi: number; L: PdfLine; pos: "top" | "bot"; key: string; gap: number }> = [];
  pages.forEach((page, pi) => {
    // A rule is a drawing, not a line of text: it cannot be a running head or a
    // page number. A rotated run is handled by its own pass below.
    const eligible = page.lines.filter((line) => !line.rule && !line.rotated);
    const top = eligible.slice(0, 2).filter((line) => line.y > page.height * (1 - band));
    const bot = eligible
      .slice(Math.max(0, eligible.length - 2))
      .filter((line) => line.y < page.height * band && !top.includes(line));
    const gapOf = (line: PdfLine, pos: "top" | "bot") => {
      if (line.gap != null) return line.gap;
      const others = eligible.filter((row) => row !== line);
      if (pos === "top") {
        const below = others.filter((row) => row.y < line.y).sort((a, b) => b.y - a.y)[0];
        return below ? line.y - below.y : page.height;
      }
      const above = others.filter((row) => row.y > line.y).sort((a, b) => a.y - b.y)[0];
      return above ? above.y - line.y : page.height;
    };
    for (const line of top) cands.push({ pi, L: line, pos: "top", key: normKey(line.text), gap: gapOf(line, "top") });
    for (const line of bot) cands.push({ pi, L: line, pos: "bot", key: normKey(line.text), gap: gapOf(line, "bot") });
  });

  /**
   * Mark a rotated run as furniture.
   *
   * A rotated item is one whose glyphs are not level with the page. Body text
   * is never set that way; a publisher's DOI banner down the side margin is,
   * and it is page furniture on every page that carries it. Requiring it to
   * repeat across pages keeps a one-off rotated figure label in the body.
   */
  const rotatedKeys = new Map<string, Set<number>>();
  pages.forEach((page, pi) => {
    for (const line of page.lines) {
      if (!line.rotated) continue;
      const key = normKey(line.text);
      if (key.length < 3) continue;
      const set = rotatedKeys.get(key) ?? new Set<number>();
      set.add(pi);
      rotatedKeys.set(key, set);
    }
  });
  for (const [key, seen] of rotatedKeys) {
    if (seen.size < minRepeat) continue;
    pages.forEach((page, pi) => {
      if (!seen.has(pi)) return;
      for (const line of page.lines) {
        if (!line.rotated || normKey(line.text) !== key) continue;
        line.role = "furniture";
        line.why = "rotated_margin";
      }
    });
  }

  /**
   * A group that is *always* the page's own first or last line, on five or more
   * pages, and is set apart from the text, is a running head or foot whatever
   * `measureBody` decided.
   *
   * This is what the rule-merge bug made necessary: the header became the body
   * top, so no comparison against the body could recover it. "Set apart" is the
   * guard that keeps a page's genuine first or last *content* line: a line that
   * sits at normal leading is part of the paragraph flow and stays body, while
   * one separated by a gap or by a drawing rule is a margin line.
   */
  const edgeSeen = new Map<string, number>();
  const edgeDetached = new Map<string, boolean>();
  pages.forEach((page) => {
    const eligible = page.lines.filter((line) => !line.rule && !line.rotated);
    if (eligible.length === 0) return;
    const first = eligible[0];
    const last = eligible[eligible.length - 1];
    const rows: Array<{ id: string; line: PdfLine }> = [];
    if (first) rows.push({ id: `top:${normKey(first.text)}`, line: first });
    if (last && last !== first) rows.push({ id: `bot:${normKey(last.text)}`, line: last });
    for (const { id, line } of rows) {
      if (id.length <= 4) continue;
      edgeSeen.set(id, (edgeSeen.get(id) ?? 0) + 1);
      if (!edgeDetached.get(id)) edgeDetached.set(id, edgeIsSetApart(page, line, docSpacing));
    }
  });
  for (const [id, count] of edgeSeen) {
    if (count >= 5 && edgeDetached.get(id)) alwaysEdge.add(id);
  }
  const sizeOutlier = (height: number, groupHeight: number) =>
    height > groupHeight * 1.25 && height > docBodyH * 1.35;
  const exact = new Map<string, { pos: "top" | "bot"; key: string; members: typeof cands }>();
  for (const cand of cands) {
    if (cand.key.length < 3) continue;
    const id = `${cand.pos}:${cand.key}`;
    const group = exact.get(id) ?? { pos: cand.pos, key: cand.key, members: [] };
    group.members.push(cand);
    exact.set(id, group);
  }
  const big = [...exact.values()]
    .filter((group) => group.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length);
  const groups = [...big];
  for (const group of exact.values()) {
    if (group.members.length >= 2) continue;
    const target =
      group.key.length <= 80
        ? big.find(
            (other) =>
              other.pos === group.pos &&
              Math.abs(other.key.length - group.key.length) <= 0.3 * other.key.length &&
              ratio(other.key, group.key) >= fuzz
          )
        : undefined;
    if (target) target.members.push(...group.members);
    else groups.push(group);
  }
  const exactPages = new Map<string, number>();
  for (const cand of cands) {
    if (cand.key.length < 3) continue;
    const id = `${cand.pos}:${cand.key}`;
    exactPages.set(id, (exactPages.get(id) || 0) + 1);
  }
  for (const group of groups) {
    if (new Set(group.members.map((cand) => cand.pi)).size < minRepeat) continue;
    const y = median(group.members.map((cand) => cand.L.y));
    const h = median(group.members.map((cand) => cand.L.h));
    const frequent = new Set(group.members.map((cand) => cand.pi)).size >= 5;
    for (const cand of group.members) {
      if (!outsideBody(cand)) continue;
      if ((exactPages.get(`${cand.pos}:${cand.key}`) || 0) < 2 && !(frequent && cand.gap > docSpacing + 2)) continue;
      if (isBareStructuralHeading(cand.L.text)) continue;
      if (sizeOutlier(cand.L.h, h)) continue;
      const aligned = Math.abs(cand.L.y - y) <= Math.max(8, 0.8 * h);
      if (!aligned) continue;
      if (frequent || cand.gap > docSpacing + 2 || alwaysEdge.has(`${cand.pos}:${cand.key}`)) {
        cand.L.role = "furniture";
        cand.L.why = "running_head";
      }
    }
  }
  const numOf = (text: string) => {
    const match = text.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").match(/^[\W_]{0,3}(\d{1,4})[\W_]{0,3}$/);
    return match ? Number(match[1]) : null;
  };
  const offCount = new Map<number, number>();
  const romanOff = new Map<number, number>();
  for (const cand of cands) {
    const n = numOf(cand.L.text);
    if (n != null) offCount.set(n - cand.pi, (offCount.get(n - cand.pi) || 0) + 1);
    const roman = romanValue(cand.L.text);
    if (roman != null) romanOff.set(roman - cand.pi, (romanOff.get(roman - cand.pi) || 0) + 1);
  }
  for (const cand of cands) {
    if (cand.L.role) continue;
    if (isBareStructuralHeading(cand.L.text) || isNumberedStructuralHeading(cand.L.text)) continue;
    const n = numOf(cand.L.text);
    if (n != null && (offCount.get(n - cand.pi) || 0) >= 3) {
      cand.L.role = "furniture";
      cand.L.why = "page_number";
      continue;
    }
    const roman = romanValue(cand.L.text);
    if (roman != null && cand.pi < 40 && (romanOff.get(roman - cand.pi) || 0) >= 3) {
      cand.L.role = "furniture";
      cand.L.why = "roman_page_number";
    }
  }
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.why !== "running_head") continue;
      if (isBareStructuralHeading(line.text)) {
        line.role = undefined;
        line.why = undefined;
        continue;
      }
      const copies = pages.flatMap((other, index) =>
        other.lines.some((otherLine) => otherLine.text === line.text) ? [index] : []
      );
      const spread =
        copies.length >= 2 &&
        copies.length < 5 &&
        copies.every((index, i) => i === 0 || index - copies[i - 1]! > 1) &&
        copies.some((index, i) => i > 0 && index - copies[i - 1]! > 2);
      if (spread) {
        line.role = undefined;
        line.why = undefined;
        continue;
      }
      if (!isNumberedStructuralHeading(line.text)) continue;
      const repeats = pages.filter((other) =>
        other.lines.some(
          (otherLine) =>
            otherLine.text === line.text &&
            Math.abs(otherLine.y - line.y) <= Math.max(8, 0.8 * line.h)
        )
      ).length;
      const indexes = pages.flatMap((other, index) =>
        other.lines.some((otherLine) => otherLine.text === line.text) ? [index] : []
      );
      const nonConsecutive =
        indexes.length >= 2 &&
        indexes.every((index, i) => i === 0 || index - indexes[i - 1]! > 1) &&
        indexes.some((index, i) => i > 0 && index - indexes[i - 1]! > 2);
      if (repeats < minRepeat || nonConsecutive) {
        line.role = undefined;
        line.why = undefined;
      }
    }
    const heading = page.lines.find((line) => isBareStructuralHeading(line.text) || isNumberedStructuralHeading(line.text));
    if (!heading) continue;
    for (const line of page.lines) {
      if (line.why !== "page_number" && line.why !== "roman_page_number") continue;
      if (Math.abs(line.y - heading.y) <= 36) {
        line.role = undefined;
        line.why = undefined;
      }
    }
  }
  const blocks: FurnitureBlock[] = [];
  pages.forEach((page, pi) => {
    // A drawing rule is not narration. It stays in `lines` so the body block can
    // be measured without it, but its characters never reach the body text.
    for (const line of page.lines) {
      if (line.rule && !line.role) {
        line.role = "furniture";
        line.why = "rule";
      }
    }
    if (page.flow) {
      let cur: FurnitureBlock | null = null;
      for (const seg of page.flow) {
        const role = seg.line?.role === "furniture" ? "furniture" : "body";
        const why = seg.line?.role === "furniture" ? seg.line.why || "furniture" : "text";
        if (!cur || cur.role !== role) {
          cur = { page: pi, text: "", role, label: why };
          blocks.push(cur);
        }
        cur.text += seg.text;
      }
      return;
    }
    const roleOf = new Map<number, ["body" | "furniture", string]>();
    for (const line of page.lines) {
      for (const item of line.items) {
        roleOf.set(item.k, line.role ? [line.role, line.why || "furniture"] : ["body", "text"]);
      }
    }
    let cur: FurnitureBlock | null = null;
    for (const item of page.items) {
      const marked: ["body" | "furniture", string] = roleOf.get(item.k) ||
        (cur ? [cur.role, cur.label] : ["body", "text"]);
      const [role, why] = marked;
      if (!cur || cur.role !== role) {
        cur = { page: pi, text: "", role, label: why };
        blocks.push(cur);
      }
      cur.text += item.s + (item.eol ? "\n" : "");
    }
  });
  return blocks;
}

/** Body text of each page, furniture removed, pdf.js item order.
 *
 * Blank pages keep their slot as an empty string. Dropping them shifted every
 * later index, so a PDF outline destination (`pageIndex` from pdf.js) pointed
 * at the wrong page after the first blank one.
 */
export function bodyTextByPage(blocks: FurnitureBlock[]): string[] {
  const pages: string[] = [];
  for (const block of blocks) {
    if (block.role !== "body") continue;
    pages[block.page] = (pages[block.page] || "") + block.text;
  }
  const last = pages.length - 1;
  for (let i = 0; i <= last; i++) {
    if (pages[i] == null) pages[i] = "";
  }
  return pages;
}
