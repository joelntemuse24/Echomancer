/**
 * HTML → blocks.
 *
 * Used by the web-page intake and by EPUB, which is HTML too. The old path
 * flattened the document to a string, which threw away `<h1>`–`<h6>`: a
 * Wikipedia article or a Gutenberg HTML book then had no headings at all, so
 * chapter detection saw plain prose and found nothing.
 *
 * Region selection is `@mozilla/readability` (Apache-2.0) when it succeeds,
 * so scripts, menus, and "related" rails never reach the narrator. Its output
 * is then cleaned by the same chrome rules the old extractor used, and walked
 * into blocks here. When Readability produces nothing usable the previous
 * `<article>`/`<main>`/`<body>` selection is the fallback.
 */

import type { BlockKind, BookBlock } from "@/lib/blocks";
import { parseHTML } from "linkedom";
import { decodeHtmlEntities, normalizePageText } from "@/lib/html-article";

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

/**
 * Elements whose whole subtree is never narrated. `<sup>` is a footnote
 * reference ("hurricanes<sup>[1]</sup>") which glues a bare digit onto the
 * preceding word.
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
  "sup",
  "figure",
]);

/** Chrome whose class, id, or role says what it is. */
const CHROME_ATTR =
  /\b(?:navbar|menu|footer|sidebar|breadcrumb|cookie|interlanguage|noprint|mw-portlet|vector-menu|vector-dropdown|site-header|site-footer|skip-link|lang-list|language-list|topbar|top-bar|trending|related-posts|related-articles|more-stories|more-from|byline|author-bio|newsletter|subscribe-box|promo|advert|ad-slot|sponsored|share-bar|sharebar|social-links|social-share|sharing-buttons|infobox|navbox|reflist|mw-editsection|mw-jump-link|catlinks|printfooter)\b/i;

const CHROME_ROLES = new Set([
  "navigation",
  "contentinfo",
  "banner",
  "complementary",
  "search",
]);

const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Elements that open a new paragraph. */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "body",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "header",
  "html",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "thead",
  "tr",
  "ul",
]);

type Elementish = {
  nodeType: number;
  nodeName?: string;
  textContent?: string | null;
  childNodes?: ArrayLike<Elementish>;
  getAttribute?: (name: string) => string | null;
  querySelectorAll?: (selector: string) => ArrayLike<Elementish>;
  remove?: () => void;
};

function isElement(node: Elementish): boolean {
  return node.nodeType === 1;
}

function tagOf(node: Elementish): string {
  return (node.nodeName ?? "").toLowerCase();
}

function attrOf(node: Elementish, name: string): string {
  return (node.getAttribute?.(name) ?? "").trim();
}

function children(node: Elementish): Elementish[] {
  return Array.from(node.childNodes ?? []);
}

function isChromeElement(node: Elementish): boolean {
  if (!isElement(node)) return false;
  const name = tagOf(node);
  if (DROP_TAGS.has(name)) return name !== "figure";
  if (name === "html" || name === "body") return false;
  if (CHROME_ROLES.has(attrOf(node, "role").toLowerCase())) return true;
  return CHROME_ATTR.test(`${attrOf(node, "class")} ${attrOf(node, "id")}`);
}

/**
 * Remove chrome subtrees in place. Only *descendants* of the chosen region are
 * checked, so a page whose own `<body class="…">` mentions a menu keeps its
 * article.
 */
function dropChrome(root: Elementish): void {
  const all = root.querySelectorAll?.("*") ?? [];
  const doomed: Elementish[] = [];
  for (let i = 0; i < all.length; i++) {
    const node = all[i]!;
    if (isChromeElement(node)) doomed.push(node);
  }
  for (const node of doomed) node.remove?.();
}

type Walk = {
  blocks: BookBlock[];
  /** Accumulated inline text for the block currently open. */
  buffer: string;
  /** Kind of the block currently open. */
  kind: BlockKind;
  /** Heading depth of the block currently open. */
  level: number;
  /** Anchor id seen since the last flush, attached to the next block. */
  anchor: string | null;
  /** Inside a `<pre>`: line breaks are significant. */
  pre: number;
};

function flush(walk: Walk): void {
  const raw = normalizePageText(decodeHtmlEntities(walk.buffer));
  const anchor = walk.anchor;
  walk.buffer = "";
  walk.anchor = null;
  if (!raw) return;
  for (const part of raw.split(/\n\s*\n/)) {
    const text = part.replace(/[^\S\n]+/g, " ").trim();
    if (!text) continue;
    walk.blocks.push({
      kind: walk.kind,
      ...(walk.kind === "heading" ? { level: walk.level } : {}),
      text,
      ...(anchor ? { source: { id: anchor } } : {}),
    });
    if (anchor) break;
  }
}

function walkNode(node: Elementish, walk: Walk): void {
  if (node.nodeType === 3) {
    walk.buffer += node.textContent ?? "";
    return;
  }
  if (!isElement(node)) return;
  const name = tagOf(node);
  if (DROP_TAGS.has(name)) return;

  const id = attrOf(node, "id");
  if (id) walk.anchor = id;

  if (name === "br") {
    walk.buffer += walk.pre > 0 ? "\n" : " ";
    return;
  }
  if (name === "hr") {
    flush(walk);
    return;
  }

  const headingLevel = HEADING_TAGS[name];
  if (headingLevel) {
    // The heading's own id is the anchor its TOC entry points at, so it has
    // to survive the flush that closes the block above it.
    const anchor = walk.anchor;
    walk.anchor = null;
    flush(walk);
    walk.anchor = anchor;
    const saved = { kind: walk.kind, level: walk.level };
    walk.kind = "heading";
    walk.level = headingLevel;
    for (const child of children(node)) walkNode(child, walk);
    flush(walk);
    walk.kind = saved.kind;
    walk.level = saved.level;
    return;
  }

  const listKind: BlockKind | null = name === "li" ? "list-item" : null;
  if (listKind) {
    flush(walk);
    const saved = walk.kind;
    walk.kind = listKind;
    for (const child of children(node)) walkNode(child, walk);
    flush(walk);
    walk.kind = saved;
    return;
  }

  if (name === "blockquote" || name === "figcaption") {
    flush(walk);
    const saved = walk.kind;
    walk.kind = name === "blockquote" ? "quote" : "caption";
    for (const child of children(node)) walkNode(child, walk);
    flush(walk);
    walk.kind = saved;
    return;
  }

  if (name === "tr") {
    // A real table row holds short cells. A layout table (a `<tr><td>` wrapping
    // whole chapters) is walked like any other container instead of being
    // flattened into one line.
    const cells = children(node).filter((cell) => ["td", "th"].includes(tagOf(cell)));
    const flat =
      cells.length >= 2 &&
      cells.every((cell) => !children(cell).some((child) => BLOCK_TAGS.has(tagOf(child))));
    if (flat) {
      flush(walk);
      const text = cells
        .map((cell) => normalizePageText(decodeHtmlEntities(cell.textContent ?? "")))
        .filter(Boolean);
      if (text.length > 0) walk.blocks.push({ kind: "table", text: text.join(", ") });
      return;
    }
  }

  if (name === "pre") {
    flush(walk);
    walk.pre += 1;
    for (const child of children(node)) walkNode(child, walk);
    walk.pre = Math.max(0, walk.pre - 1);
    flush(walk);
    return;
  }

  if (BLOCK_TAGS.has(name)) {
    // A block container with text of its own is a paragraph; one that only
    // holds other blocks just scopes them.
    flush(walk);
    for (const child of children(node)) walkNode(child, walk);
    flush(walk);
    return;
  }

  if (VOID_TAGS.has(name)) return;
  for (const child of children(node)) walkNode(child, walk);
}

/** Walk an HTML fragment into blocks. Chrome inside it is dropped first. */
export function htmlRegionToBlocks(region: string): BookBlock[] {
  let root: Elementish | null = null;
  try {
    const { document } = parseHTML(
      `<!doctype html><html><body><div id="ec-article">${region}</div></body></html>`
    ) as unknown as { document: { documentElement: Elementish } };
    root =
      document.documentElement.querySelectorAll?.("#ec-article")?.[0] ?? null;
  } catch {
    root = null;
  }
  if (!root) return [];
  dropChrome(root);
  const walk: Walk = {
    blocks: [],
    buffer: "",
    kind: "para",
    level: 1,
    anchor: null,
    pre: 0,
  };
  for (const child of children(root)) walkNode(child, walk);
  flush(walk);
  return walk.blocks;
}
