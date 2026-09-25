/**
 * Layout-aware page furniture on pdf.js text items.
 *
 * A line is furniture only when it sits in the top or bottom band of a page
 * and it is a page number that agrees with the page index, or the same
 * letters-only line repeats at that position on at least three pages.
 * A line that appears once is kept. A line clearly larger than the body,
 * or a bare Chapter/Part/Lecture/Letter heading, is kept. A numbered
 * heading (Lecture I, Letter 1) is kept unless that exact line repeats.
 * A running head also needs a gap larger than normal line spacing.
 */

export type PdfTextItem = {
  k: number;
  s: string;
  eol: boolean;
  x: number;
  y: number;
  h: number;
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
};

export type PdfPage = {
  height: number;
  items: PdfTextItem[];
  lines: PdfLine[];
  /** Item-order text. Edge lines point at `lines`; body lines are inlined. */
  flow?: Array<{ text: string; line: PdfLine | null }>;
  bodyH?: number;
  spacing?: number;
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

function pageStats(page: PdfPage): { bodyH: number; spacing: number } {
  const edge = new Set<PdfLine>([
    ...page.lines.slice(0, 2),
    ...page.lines.slice(Math.max(0, page.lines.length - 2)),
  ]);
  const body = page.lines.filter((line) => !edge.has(line));
  const heights = (body.length ? body : page.lines).map((line) => line.h);
  const gaps: number[] = [];
  for (let i = 1; i < body.length; i++) {
    const gap = Math.abs(body[i - 1]!.y - body[i]!.y);
    if (gap > 0) gaps.push(gap);
  }
  return { bodyH: median(heights) || 11, spacing: median(gaps) || 14 };
}

function gapTowardBody(lines: PdfLine[], index: number): number {
  const line = lines[index]!;
  const fromTop = index;
  const fromBot = lines.length - 1 - index;
  if (fromTop <= fromBot) {
    const below = lines[index + 1];
    return below ? line.y - below.y : line.y;
  }
  const above = lines[index - 1];
  return above ? above.y - line.y : line.y;
}

/** Drop item payloads. Keep edge lines plus item-order text. */
export function compactPage(page: PdfPage): PdfPage {
  const stats = pageStats(page);
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
    const kept = line && edge.has(line) ? line : null;
    const piece = item.s + (item.eol ? "\n" : "");
    const last = flow[flow.length - 1];
    if (last && last.line === kept) last.text += piece;
    else flow.push({ text: piece, line: kept });
  }
  for (const line of edge) line.items = [];
  return {
    height: page.height,
    items: [],
    lines: [...edge],
    flow,
    bodyH: stats.bodyH,
    spacing: stats.spacing,
  };
}

/** Group pdf.js items into visual lines. Item order on the page is preserved. */
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
      return [{
        k,
        s: raw.str,
        eol: "hasEOL" in raw && Boolean(raw.hasEOL),
        x: typeof transform[4] === "number" ? transform[4] : 0,
        y: typeof transform[5] === "number" ? transform[5] : 0,
        h: Math.abs(yScale) || height || 10,
      }];
    });
    pages.push(compactPage(pageFromItems(items, viewport.height)));
    page.cleanup?.();
  }
  return pages;
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
  const cands: Array<{ pi: number; L: PdfLine; pos: "top" | "bot"; key: string; bodyH: number; spacing: number; gap: number }> = [];
  pages.forEach((page, pi) => {
    const stats = page.flow ? { bodyH: page.bodyH || 11, spacing: page.spacing || 14 } : pageStats(page);
    const top = page.lines.slice(0, 2).filter((line) => line.y > page.height * (1 - band));
    const bot = page.lines
      .slice(Math.max(0, page.lines.length - 2))
      .filter((line) => line.y < page.height * band && !top.includes(line));
    const gapOf = (line: PdfLine, pos: "top" | "bot") => {
      if (line.gap != null) return line.gap;
      const others = page.lines.filter((row) => row !== line);
      if (pos === "top") {
        const below = others.filter((row) => row.y < line.y).sort((a, b) => b.y - a.y)[0];
        return below ? line.y - below.y : page.height;
      }
      const above = others.filter((row) => row.y > line.y).sort((a, b) => a.y - b.y)[0];
      return above ? above.y - line.y : page.height;
    };
    for (const line of top) {
      cands.push({ pi, L: line, pos: "top", key: normKey(line.text), ...stats, gap: gapOf(line, "top") });
    }
    for (const line of bot) {
      cands.push({ pi, L: line, pos: "bot", key: normKey(line.text), ...stats, gap: gapOf(line, "bot") });
    }
  });
  const isolated = (cand: (typeof cands)[number]) => {
    if (cand.L.h > cand.bodyH * 1.25) return false;
    if (isBareStructuralHeading(cand.L.text)) return false;
    const minGap = Math.max(24, cand.spacing * 1.8);
    return cand.gap > minGap;
  };
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
    for (const cand of group.members) {
      if ((exactPages.get(`${cand.pos}:${cand.key}`) || 0) < 2) continue;
      if (!isolated(cand)) continue;
      if (Math.abs(cand.L.y - y) <= Math.max(8, 0.8 * h) && cand.L.h <= h * 1.35) {
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
    if (cand.L.h > cand.bodyH * 1.25) continue;
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
    const first = page.lines[0];
    if (!first || first.why !== "running_head" || !isNumberedStructuralHeading(first.text)) continue;
    const repeats = pages.filter((other) =>
      other.lines.some(
        (line) =>
          line.why === "running_head" &&
          line.text === first.text &&
          Math.abs(line.y - first.y) <= Math.max(8, 0.8 * first.h)
      )
    ).length;
    if (repeats < minRepeat) {
      first.role = undefined;
      first.why = undefined;
    }
  }
  const blocks: FurnitureBlock[] = [];
  pages.forEach((page, pi) => {
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

/** Body text of each page, furniture removed, pdf.js item order. */
export function bodyTextByPage(blocks: FurnitureBlock[]): string[] {
  const pages: string[] = [];
  for (const block of blocks) {
    if (block.role !== "body") continue;
    pages[block.page] = (pages[block.page] || "") + block.text;
  }
  return pages.filter((page) => page != null && page.trim());
}
