/**
 * Pull blocks out of a fetched HTML page.
 *
 * Region selection is `@mozilla/readability` (Apache-2.0): it scores candidate
 * containers and returns the article, which keeps `<h1>`–`<h6>` intact. The
 * old extractor flattened the page to text and lost every heading, so a
 * Wikipedia article or a Gutenberg HTML book produced no chapters at all.
 *
 * `html-blocks.ts` then turns that region into blocks, applying the same
 * chrome rules the old extractor used (link-only rows, trending rails,
 * language menus). The old `<article>` / `<main>` / `<body>` selection stays
 * as the fallback for pages Readability cannot score.
 */

import type { BookBlock } from "@/lib/blocks";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { decodeHtmlEntities, normalizePageText } from "@/lib/html-entities";
import { htmlRegionToBlocks } from "@/lib/html-blocks";

export { decodeHtmlEntities, normalizePageText } from "@/lib/html-entities";

/** Below this many characters Readability's answer is not worth trusting. */
const MIN_ARTICLE_CHARS = 250;

export type HtmlArticle = {
  title: string | null;
  /** The article as blocks, headings included. */
  blocks: BookBlock[];
  /** The same content as one string, for callers that only want text. */
  text: string;
};

function roughLength(html: string): number {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
}

/**
 * The article region via Readability, or null when it declines or returns a
 * stub. `charThreshold` is lowered because a short essay is a legitimate read.
 */
function readabilityRegion(html: string): { region: string; title: string | null } | null {
  try {
    const { document } = parseHTML(html) as unknown as {
      document: ConstructorParameters<typeof Readability>[0];
    };
    const reader = new Readability(document, {
      charThreshold: MIN_ARTICLE_CHARS,
      // Classes are kept: the chrome rules match on them ("infobox",
      // "navbox", "mw-portlet"), and stripping them made every such
      // subtree look like ordinary content.
      keepClasses: true,
    });
    const article = reader.parse();
    const content = article?.content ?? "";
    if (roughLength(content) < MIN_ARTICLE_CHARS) return null;
    return { region: content, title: article?.title?.trim() || null };
  } catch {
    return null;
  }
}

/** Text blocks joined the same way `toSpeakableText` reads paragraphs. */
function blocksToText(blocks: BookBlock[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}

/**
 * Read a page into blocks. The region is chosen by Readability, then by the
 * legacy `<article>` / `<main>` / `<body>` picker, and only what is inside it
 * is walked — so a page with several articles narrates the one worth reading.
 */
export function htmlToArticleBlocks(html: string): HtmlArticle {
  const fallbackTitle = extractTitle(html);
  const picked = readabilityRegion(html);
  if (picked) {
    const blocks = htmlRegionToBlocks(picked.region);
    if (blocks.length > 0) {
      return { title: picked.title ?? fallbackTitle, blocks, text: blocksToText(blocks) };
    }
  }
  const region = pickContent(dropElements(html));
  const blocks = htmlRegionToBlocks(region);
  if (blocks.length > 0) {
    return { title: fallbackTitle, blocks, text: blocksToText(blocks) };
  }
  // Both region pickers came up empty: use the legacy flatten so a page with an
  // unusual shape still reads.
  const legacy = legacyArticle(html);
  return { title: legacy.title, blocks: [], text: legacy.text };
}

export function htmlToArticle(html: string): { title: string | null; text: string } {
  const article = htmlToArticleBlocks(html);
  return { title: article.title, text: article.text };
}

/** The pre-Readability region picker, kept for the fallback and its tests. */
function legacyArticle(html: string): { title: string | null; text: string } {
  const title = extractTitle(html);
  const cleaned = dropElements(html);
  return { title, text: htmlToText(pickContent(cleaned)) };
}

// ── Legacy region selection ───────────────────────────────────────────

function attrValue(raw: string, name: string): string {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i"
  ).exec(raw);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
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
    const name = /\b(?:property|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/i.exec(tag);
    const got = (name?.[1] || name?.[2] || name?.[3] || "").toLowerCase();
    if (got !== key) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (value) return cleanTitle(value);
  }
  return null;
}

function extractTitle(html: string): string | null {
  const social = metaContent(html, "og:title") || metaContent(html, "twitter:title");
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

/** Tag ends at `>`, not at a `>` inside a quoted attribute. */
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

type ParsedTag = { name: string; closing: boolean; selfClosing: boolean };

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
  "figure",
  "sup",
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

const RAW_TAGS = new Set(["script", "style", "textarea", "title", "noscript"]);

const CHROME_ATTR =
  /\b(?:navbar|menu|footer|sidebar|breadcrumb|cookie|interlanguage|noprint|mw-portlet|vector-menu|vector-dropdown|site-header|site-footer|skip-link|lang-list|language-list|topbar|top-bar|trending|related-posts|related-articles|more-stories|more-from|byline|author-bio|newsletter|subscribe-box|promo|advert|ad-slot|sponsored|share-bar|sharebar|social-links|social-share|sharing-buttons)\b/i;

const CHROME_ROLES = new Set(["navigation", "contentinfo", "banner", "complementary", "search"]);

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

function isLinkDenseChrome(inner: string): boolean {
  const anchors = inner.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  if (anchors.length < 2) return false;
  const anchorText = anchors
    .map((anchor) => anchor.replace(/<[^>]+>/g, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!anchorText) return false;
  const allText = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return allText.length <= 200 && anchorText.length >= allText.length * 0.6;
}

function isChrome(raw: string, parsed: ParsedTag): boolean {
  if (DROP_TAGS.has(parsed.name)) return true;
  if (parsed.name === "html" || parsed.name === "body") return false;
  if (CHROME_ROLES.has(attrValue(raw, "role").toLowerCase())) return true;
  return CHROME_ATTR.test(`${attrValue(raw, "class")} ${attrValue(raw, "id")}`);
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
    if (
      parsed &&
      !parsed.closing &&
      !parsed.selfClosing &&
      BLOCK_TAGS.has(parsed.name) &&
      parsed.name !== "article" &&
      parsed.name !== "main" &&
      parsed.name !== "body"
    ) {
      const found = findMatchingClose(html, gt + 1, parsed.name);
      if (found && isLinkDenseChrome(html.slice(gt + 1, found.closeStart))) {
        index = found.after;
        continue;
      }
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

function largestRegion(html: string, tag: string): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const region of innerRegions(html, tag)) {
    const length = roughLength(region);
    if (length > bestLength) {
      best = region;
      bestLength = length;
    }
  }
  return best;
}

function worthReading(region: string, bodyLength: number): boolean {
  const length = roughLength(region);
  if (length < 80) return false;
  return bodyLength < 200 || length >= bodyLength * 0.25;
}

function pickContent(html: string): string {
  const body = innerRegions(html, "body")[0] ?? html;
  const bodyLength = roughLength(body);
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
    } else if (parsed && BLOCK_TAGS.has(parsed.name) && (parsed.closing || !parsed.selfClosing)) {
      out += "\n\n";
    }
    index = gt + 1;
  }
  return normalizePageText(decodeHtmlEntities(out));
}
