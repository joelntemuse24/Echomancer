/**
 * Pull the readable text out of a fetched HTML page.
 *
 * Scripts, styles, and page chrome are dropped. When the page has an
 * `<article>` or `<main>` that holds a real share of the body, that region
 * is what gets narrated.
 */

const DROP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "template",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "head",
  "object",
  "embed",
  "link",
  "meta",
  "input",
  "select",
  "textarea",
  "dialog",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** These elements do not nest. The first closing tag ends them. */
const RAW_TAGS = new Set(["script", "style", "textarea", "title", "noscript"]);

/** Class, id, and role tokens that are page chrome rather than the piece to read. */
const CHROME_ATTR =
  /\b(?:navbar|menu|footer|sidebar|breadcrumb|cookie|interlanguage|noprint|mw-portlet|vector-menu|vector-dropdown|site-header|site-footer|skip-link|lang-list|language-list)\b/i;

const CHROME_ROLES = new Set([
  "navigation",
  "contentinfo",
  "banner",
  "complementary",
  "search",
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "body",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);

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

type ParsedTag = {
  name: string;
  closing: boolean;
  selfClosing: boolean;
};

function attrValue(raw: string, name: string): string {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i"
  ).exec(raw);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function isChrome(raw: string, parsed: ParsedTag): boolean {
  if (DROP_TAGS.has(parsed.name)) return true;
  // Skin classes on the document itself are not a menu widget.
  if (parsed.name === "html" || parsed.name === "body") return false;
  if (CHROME_ROLES.has(attrValue(raw, "role").toLowerCase())) return true;
  const classId = `${attrValue(raw, "class")} ${attrValue(raw, "id")}`;
  return CHROME_ATTR.test(classId);
}

/** Tag ends at `>`, not at a `>` that sits inside a quoted attribute. */
function findTagEnd(html: string, lt: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = lt + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function parseTag(raw: string): ParsedTag | null {
  const match = /^<\s*(\/)?\s*([a-zA-Z][\w:-]*)\b([^>]*)>$/.exec(raw);
  const rawName = match?.[2];
  if (!match || !rawName) return null;
  const name = rawName.toLowerCase();
  const closing = Boolean(match[1]);
  const selfClosing = closing
    ? false
    : /\s*\/\s*$/.test(match[3] || "") || VOID_TAGS.has(name);
  return { name, closing, selfClosing };
}

function findMatchingClose(
  html: string,
  from: number,
  name: string
): { closeStart: number; after: number } | null {
  if (RAW_TAGS.has(name)) {
    const match = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(from));
    if (!match) return null;
    const closeStart = from + match.index;
    return { closeStart, after: closeStart + match[0].length };
  }

  let depth = 1;
  let index = from;
  while (index < html.length && depth > 0) {
    const lt = html.indexOf("<", index);
    if (lt === -1) return null;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt === -1) return null;
    const parsed = parseTag(html.slice(lt, gt + 1));
    index = gt + 1;
    if (!parsed || parsed.name !== name || parsed.selfClosing) continue;
    if (parsed.closing) {
      depth -= 1;
      if (depth === 0) return { closeStart: lt, after: gt + 1 };
    } else {
      depth += 1;
    }
  }
  return null;
}

function dropElements(html: string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt === -1) {
      out += html.slice(lt);
      break;
    }
    const raw = html.slice(lt, gt + 1);
    const parsed = parseTag(raw);
    if (parsed && isChrome(raw, parsed)) {
      if (!parsed.closing && !parsed.selfClosing) {
        const found = findMatchingClose(html, gt + 1, parsed.name);
        index = found ? found.after : html.length;
      } else {
        index = gt + 1;
      }
      continue;
    }
    out += raw;
    index = gt + 1;
  }
  return out;
}

function innerRegions(html: string, tag: string): string[] {
  const regions: string[] = [];
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt === -1) break;
    const parsed = parseTag(html.slice(lt, gt + 1));
    if (!parsed) {
      index = gt + 1;
      continue;
    }
    if (!parsed.closing && !parsed.selfClosing && parsed.name === tag) {
      const found = findMatchingClose(html, gt + 1, tag);
      if (!found) break;
      regions.push(html.slice(gt + 1, found.closeStart));
      index = found.after;
      continue;
    }
    index = gt + 1;
  }
  return regions;
}

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

export function normalizePageText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\u00a0/g, " ");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function cleanTitle(value: string): string | null {
  const title = decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;
  return title.slice(0, 200);
}

function metaContent(html: string, key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = /\b(?:property|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/i.exec(
      tag
    );
    const got = (name?.[1] || name?.[2] || name?.[3] || "").toLowerCase();
    if (got !== key) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
      tag
    );
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (value) return cleanTitle(value);
  }
  return null;
}

function extractTitle(html: string): string | null {
  const social =
    metaContent(html, "og:title") || metaContent(html, "twitter:title");
  if (social) return social;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) {
    const cleaned = cleanTitle(title[1]);
    if (cleaned) return cleaned;
  }
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (heading?.[1]) return cleanTitle(heading[1]);
  return null;
}

function roughTextLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function largestRegion(html: string, tag: string): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const region of innerRegions(html, tag)) {
    const length = roughTextLength(region);
    if (length > bestLength) {
      best = region;
      bestLength = length;
    }
  }
  return best;
}

function worthReading(region: string, bodyLength: number): boolean {
  const length = roughTextLength(region);
  if (length < 80) return false;
  return bodyLength < 200 || length >= bodyLength * 0.25;
}

function pickContent(html: string): string {
  const body = innerRegions(html, "body")[0] ?? html;
  const bodyLength = roughTextLength(body);
  const article = largestRegion(body, "article");
  if (article && worthReading(article, bodyLength)) return article;
  const main = largestRegion(body, "main");
  if (main && worthReading(main, bodyLength)) return main;
  return body;
}

function htmlToText(html: string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt === -1) {
      out += html.slice(lt);
      break;
    }
    const parsed = parseTag(html.slice(lt, gt + 1));
    if (parsed && (parsed.name === "br" || parsed.name === "hr")) {
      out += "\n";
    } else if (
      parsed &&
      BLOCK_TAGS.has(parsed.name) &&
      (parsed.closing || !parsed.selfClosing)
    ) {
      out += "\n\n";
    }
    index = gt + 1;
  }
  return normalizePageText(decodeHtmlEntities(out));
}

export function htmlToArticle(html: string): { title: string | null; text: string } {
  const title = extractTitle(html);
  const cleaned = dropElements(html);
  return { title, text: htmlToText(pickContent(cleaned)) };
}
