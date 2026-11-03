/**
 * HTML entities and page whitespace.
 *
 * Split out of `html-article.ts` so the narration path can decode `&amp;`
 * without importing the DOM-dependent article extractor. The extract Worker
 * bundles this file; it must stay dependency-free.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  deg: "°",
  divide: "÷",
  euro: "€",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  pound: "£",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  shy: "",
  times: "×",
  trade: "™",
  yen: "¥",
};

export function decodeHtmlEntities(input: string): string {
  let output = input;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = output.replace(
      /&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi,
      (all, body: string) => {
        if (body[0] === "#") {
          const hex = body[1] === "x" || body[1] === "X";
          const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
          if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
            return all;
          }
          if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "";
          if (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) {
            return "";
          }
          return String.fromCodePoint(codePoint);
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? all;
      }
    );
    if (next === output) break;
    output = next;
  }
  return output;
}

/** Collapse a scraped run of text to paragraphs with single spaces. */
export function normalizePageText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\u00a0/g, " ");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
