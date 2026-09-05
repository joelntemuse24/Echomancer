/**
 * Map TTS windows onto book structure.
 *
 * `maxChars` is a *target*, not a knife. We fill toward that budget and only
 * end a section on a semantic boundary:
 *   page break > paragraph break > sentence
 *
 * If the budget lands in the middle of a paragraph, we stop at the previous
 * boundary (when the section is already substantial) or continue to the next
 * boundary (when stopping early would leave a stub), as long as we stay under
 * a hard ceiling so the speech API is not overflowed.
 *
 * A single paragraph longer than the hard ceiling is split on sentences, then
 * words. Mid-word cuts are last resort.
 */

/** Refuse a stub shorter than this share of the target when a later break exists. */
const MIN_FILL_RATIO = 0.55;

/** How far past the target we may run to reach the next paragraph/page. */
const OVERFLOW_RATIO = 0.25;
const OVERFLOW_MIN = 200;

export type SplitTextOptions = {
  /** Absolute ceiling. Defaults to target + overflow slack. */
  hardMaxChars?: number;
};

export function hardMaxForTarget(targetChars: number): number {
  const slack = Math.max(OVERFLOW_MIN, Math.round(targetChars * OVERFLOW_RATIO));
  return Math.max(targetChars, targetChars + slack);
}

function normalizeBookText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u000c/g, "\n\n\f\n\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

function isPageBreakBlock(block: string): boolean {
  const t = block.trim();
  if (!t) return true;
  if (t === "\f" || t.includes("\f")) return true;
  if (/^page\s+\d+$/i.test(t)) return true;
  if (/^\d+\s*\|\s*\d+$/.test(t)) return true;
  if (/^-{3,}$/.test(t)) return true;
  return false;
}

function bookUnits(text: string): { text: string; kind: "page" | "para" }[] {
  const normalized = normalizeBookText(text);
  if (!normalized) return [];

  const rawBlocks = normalized.split(/\n\s*\n/);
  const units: { text: string; kind: "page" | "para" }[] = [];

  for (const raw of rawBlocks) {
    const block = raw.replace(/[^\S\n]+/g, " ").replace(/\n/g, " ").trim();
    if (!block) continue;
    if (isPageBreakBlock(block)) {
      units.push({ text: "", kind: "page" });
      continue;
    }
    units.push({ text: block, kind: "para" });
  }

  return units;
}

function splitSentences(para: string): string[] {
  const parts = para.match(/[^.!?]+[.!?]+(?:["\u201d')\]]+)?\s*/g);
  if (!parts) return [para];
  const consumed = parts.join("").length;
  if (consumed < para.length) {
    const tail = para.slice(consumed).trim();
    return tail ? [...parts.map((p) => p.trim()), tail] : parts.map((p) => p.trim());
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

function packBySize(
  pieces: string[],
  target: number,
  hardMax: number,
  joiner: string
): string[] {
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };

  for (const piece of pieces) {
    if (!piece) continue;
    if (piece.length > hardMax) {
      flush();
      for (let i = 0; i < piece.length; i += target) {
        const slice = piece.slice(i, i + target).trim();
        if (slice) out.push(slice);
      }
      continue;
    }

    const next = current ? current + joiner + piece : piece;
    if (!current) {
      current = piece;
      continue;
    }
    if (next.length <= target) {
      current = next;
      continue;
    }
    if (next.length <= hardMax && current.length < target * MIN_FILL_RATIO) {
      current = next;
      continue;
    }
    flush();
    current = piece;
  }
  flush();
  return out;
}

function splitOversizedParagraph(para: string, target: number, hardMax: number): string[] {
  if (para.length <= hardMax) return [para];

  const sentences = splitSentences(para);
  if (sentences.length > 1) {
    const packed = packBySize(sentences, target, hardMax, " ");
    if (packed.every((p) => p.length <= hardMax)) return packed;
  }

  const words = para.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return packBySize(words, target, hardMax, " ");
  }

  const hard: string[] = [];
  for (let i = 0; i < para.length; i += target) {
    hard.push(para.slice(i, i + target));
  }
  return hard.filter(Boolean);
}

export function splitTextForTts(
  text: string,
  maxChars: number,
  opts?: SplitTextOptions
): string[] {
  if (maxChars < 10) maxChars = 10;
  const hardMax = Math.max(maxChars, opts?.hardMaxChars ?? hardMaxForTarget(maxChars));

  const units = bookUnits(text);
  if (units.length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  const appendPara = (para: string) => {
    if (!current) {
      current = para;
      return;
    }
    current = current + "\n\n" + para;
  };

  for (const unit of units) {
    if (unit.kind === "page") {
      flush();
      continue;
    }

    const para = unit.text;
    if (para.length > hardMax) {
      flush();
      for (const piece of splitOversizedParagraph(para, maxChars, hardMax)) {
        chunks.push(piece);
      }
      continue;
    }

    if (!current) {
      current = para;
      continue;
    }

    const nextLen = current.length + 2 + para.length;

    if (nextLen <= maxChars) {
      appendPara(para);
      continue;
    }

    const filledEnough = current.length >= maxChars * MIN_FILL_RATIO;
    if (filledEnough || nextLen > hardMax) {
      flush();
      current = para;
      continue;
    }

    appendPara(para);
  }

  flush();
  return chunks;
}
