/**
 * Layout-aware page furniture on pdf.js text items.
 *
 * A line is furniture only when it sits in the top or bottom band of a page
 * and it is a page number that agrees with the page index, or the same
 * letters-only line repeats at that position on at least three pages.
 * A line that appears once is kept. A chapter heading that is the first
 * line of its page is kept unless that same line repeats at that position.
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
};

export type PdfPage = {
  height: number;
  items: PdfTextItem[];
  lines: PdfLine[];
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

function isChapterStart(text: string): boolean {
  return /^(?:chapter|part|book)\s+[\divxlcdm]+\b/i.test(text.trim());
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
    pages.push(pageFromItems(items, viewport.height));
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
  const cands: Array<{ pi: number; L: PdfLine; pos: "top" | "bot"; key: string }> = [];
  pages.forEach((page, pi) => {
    const top = page.lines.slice(0, 2).filter((line) => line.y > page.height * (1 - band));
    const bot = page.lines
      .slice(Math.max(0, page.lines.length - 2))
      .filter((line) => line.y < page.height * band && !top.includes(line));
    for (const line of top) cands.push({ pi, L: line, pos: "top", key: normKey(line.text) });
    for (const line of bot) cands.push({ pi, L: line, pos: "bot", key: normKey(line.text) });
  });
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
  for (const cand of cands) {
    const n = numOf(cand.L.text);
    if (n != null) offCount.set(n - cand.pi, (offCount.get(n - cand.pi) || 0) + 1);
  }
  for (const cand of cands) {
    if (cand.L.role) continue;
    const n = numOf(cand.L.text);
    if (n != null && (offCount.get(n - cand.pi) || 0) >= 3) {
      cand.L.role = "furniture";
      cand.L.why = "page_number";
      continue;
    }
    if (/^[\W_]{0,3}[ivxlcdm]{1,7}[\W_]{0,3}$/i.test(cand.L.text) && cand.pi < 40) {
      cand.L.role = "furniture";
      cand.L.why = "roman_page_number";
    }
  }
  for (const page of pages) {
    const first = page.lines[0];
    if (!first || first.why !== "running_head" || !isChapterStart(first.text)) continue;
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
