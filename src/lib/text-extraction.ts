/**
 * Universal text extraction — converts any supported document into plain text
 * for the TTS pipeline. Format detection lives in `document-formats.ts` so the
 * browser can share it without pulling the Node-only parsers into its bundle.
 *
 * Supported formats:
 *   - PDF  (via unpdf)
 *   - EPUB (via JSZip — buffer-only, Worker-safe)
 *   - DOCX (via mammoth)
 *   - TXT  (raw UTF-8 read)
 *   - RTF  (stripped via regex — no external dep needed)
 *   - MOBI / AZW3 / AZW4 — not natively parseable in Node;
 *     requires Calibre's ebook-convert on the server. Falls back with a clear error.
 */

import type { ChapterHint } from "@/lib/book-chapters";
import { sniffDocumentFormat } from "@/lib/document-formats";
import { bodyTextByPage, extractPdfPages, markFurniture } from "@/lib/pdf-furniture";
import { unwrapPdfLines, unwrapPdfPages } from "@/lib/pdf-line-unwrap";

export { MIN_EXTRACTED_CHARS } from "@/lib/document-formats";

export interface ExtractedDocument {
  text: string;
  hint: ChapterHint;
}

export {
  detectFormat,
  SUPPORTED_DOCUMENT_ACCEPT,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  type DocumentFormat,
} from "@/lib/document-formats";

/**
 * unpdf/pdf.js reject Node `Buffer` (a Uint8Array subclass) and may read
 * `.buffer` without `byteOffset`. Always copy into a standalone Uint8Array
 * whose backing store starts at the PDF/DOCX bytes.
 */
export function asUint8Array(input: Uint8Array | Buffer): Uint8Array {
  const view =
    typeof Buffer !== "undefined" && Buffer.isBuffer(input)
      ? input
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

/**
 * Normalize extracted document text for TTS.
 *
 * Blank-line paragraphs stay paragraphs. A block that is only visual line
 * wraps (PDF `hasEOL`) is unwrapped: dehyphenate, keep headings, and do not
 * space-join the whole block into one paragraph.
 */
export function normalizeExtractedText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\u000c/g, "\n\n");
  text = text.replace(/[\x00-\x08\x0b\x0e-\x1f]/g, "");

  text = text.replace(/^\s*page\s+\d{1,4}(\s+of\s+\d{1,4})?\s*$/gim, "");
  text = text.replace(/^\s*[-–—]\s*\d{1,4}\s*[-–—]\s*$/gm, "");

  text = text.replace(/\n{3,}/g, "\n\n");

  const paragraphs: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const unwrapped = lines.length === 1 ? lines : unwrapPdfLines(lines);
    for (const para of unwrapped) {
      const cleaned = para.replace(/[^\S\n]+/g, " ").trim();
      if (cleaned) paragraphs.push(cleaned);
    }
  }

  return paragraphs.join("\n\n");
}

function headingLinesHint(): ChapterHint {
  return { source: "heading-lines", titles: [] };
}

/** Extract plain text from any supported document buffer. */
export async function extractTextFromDocument(
  input: Uint8Array | Buffer,
  fileName: string,
  mimeType?: string,
): Promise<string> {
  const extracted = await extractDocument(input, fileName, mimeType);
  return extracted.text;
}

/** Text plus a chapter hint. Outline failure must not throw from here. */
export async function extractDocument(
  input: Uint8Array | Buffer,
  fileName: string,
  mimeType?: string,
): Promise<ExtractedDocument> {
  const bytes = asUint8Array(input);
  const format = sniffDocumentFormat(bytes, fileName, mimeType);

  switch (format) {
    case "pdf":
      return extractPDF(bytes);
    case "epub":
      return extractEPUB(bytes);
    case "docx":
      return extractDOCX(bytes);
    case "txt":
      return extractTXT(bytes);
    case "rtf":
      return extractRTF(bytes);
    case "mobi":
      return extractMOBI(bytes, fileName);
    default:
      throw new Error(
        `Unsupported document format: .${fileName.split(".").pop()}. ` +
        `Supported formats: PDF, EPUB, DOCX, TXT, RTF, MOBI`
      );
  }
}

// ── PDF ────────────────────────────────────────────────────────────────

type PdfOutlineProxy = {
  getOutline(): Promise<unknown>;
};

const MAX_OUTLINE_TITLES = 400;

/**
 * Titles from the PDF outline (bookmarks), in reading order with nesting
 * level. Destinations are not resolved — the titles align against the
 * extracted paragraphs, so a page map is not needed.
 */
export async function pdfOutlineTitles(
  pdf: PdfOutlineProxy
): Promise<{ title: string; level: number }[]> {
  const outline = await pdf.getOutline().catch(() => null);
  if (!Array.isArray(outline)) return [];
  const out: { title: string; level: number }[] = [];
  const walk = (items: unknown[], level: number): void => {
    for (const item of items) {
      if (out.length >= MAX_OUTLINE_TITLES) return;
      if (!item || typeof item !== "object") continue;
      const node = item as { title?: unknown; items?: unknown };
      const title =
        typeof node.title === "string"
          ? node.title.replace(/\s+/g, " ").trim()
          : "";
      if (title && title.length <= 160) {
        out.push({ title, level });
      }
      if (Array.isArray(node.items)) walk(node.items, level + 1);
    }
  };
  walk(outline, 1);
  return out;
}

async function extractPDF(bytes: Uint8Array): Promise<ExtractedDocument> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let unwrapped = "";
  let outline: { title: string; level: number }[] = [];
  let parsed = false;
  try {
    const pdf = await getDocumentProxy(bytes);
    parsed = true;
    const laid = await extractPdfPages(pdf);
    unwrapped = unwrapPdfPages(bodyTextByPage(markFurniture(laid)));
    outline = await pdfOutlineTitles(pdf).catch(() => []);
  } catch {
    unwrapped = "";
  }
  if (!unwrapped.trim() && !parsed) {
    let text: unknown;
    try {
      const pdf = await getDocumentProxy(bytes);
      ({ text } = await extractText(pdf, { mergePages: false }));
    } catch {
      ({ text } = await extractText(bytes, { mergePages: false }));
    }
    unwrapped = unwrapPdfPages(pdfPageStrings(text));
  }

  if (!unwrapped.trim()) {
    throw new Error("Could not extract text from PDF. Is it a scanned document?");
  }
  return {
    text: normalizeExtractedText(unwrapped),
    hint:
      outline.length >= 2
        ? { source: "pdf-outline", titles: outline }
        : headingLinesHint(),
  };
}

function pdfPageStrings(text: unknown): string[] {
  if (typeof text === "string") return [text];
  if (Array.isArray(text)) {
    return text.filter((page): page is string => typeof page === "string");
  }
  return [];
}

// ── EPUB ───────────────────────────────────────────────────────────────

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`, "i"));
  return match?.[1] ?? null;
}

function htmlHeadings(html: string): { title: string; level: number }[] {
  const headings: { title: string; level: number }[] = [];
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const title = stripHtml(match[2] || "")
      .replace(/\s+/g, " ")
      .trim();
    const level = Number(match[1]);
    if (!title || title.length > 160) continue;
    headings.push({
      title,
      level: level === 2 || level === 3 ? level : 1,
    });
  }
  return headings;
}

const EPUB_DROP_TYPES = new Set([
  "copyright-page",
  "toc",
  "index",
  "colophon",
  "loi",
  "lot",
  "imprint",
]);

function epubTypes(tag: string): string[] {
  const raw = attr(tag, "epub:type") || attr(tag, "type") || "";
  return raw.toLowerCase().split(/\s+/).filter(Boolean);
}

function dropsEpubType(types: string[]): boolean {
  if (types.includes("dedication") || types.includes("epigraph")) return false;
  return types.some((type) => EPUB_DROP_TYPES.has(type));
}

/** Path of `href` relative to `baseDir`, with `.` and `..` collapsed. Empty fragments are ignored. */
export function normalizeEpubHref(baseDir: string, href: string): string | null {
  const raw = (href.split("#")[0] ?? "").trim();
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const joined = decoded.startsWith("/") ? decoded.slice(1) : `${baseDir}${decoded}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function hrefDir(href: string): string {
  const slash = href.lastIndexOf("/");
  return slash >= 0 ? href.slice(0, slash + 1) : "";
}

/** Landmark and guide hrefs whose type is front matter we do not read. */
export function epubDropHrefs(xml: string, baseDir = ""): Set<string> {
  const hrefs = new Set<string>();
  const tags = xml.match(/<(?:a|reference)\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!dropsEpubType(epubTypes(tag))) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    const path = normalizeEpubHref(baseDir, href);
    if (path) hrefs.add(path);
  }
  return hrefs;
}

/** Remove PG boilerplate and typed copyright/toc/index sections, including nested tails. */
export function stripEpubFurniture(html: string): string {
  const withoutPg = html.replace(
    /<(section|div|header|footer)\b[^>]*\bid=["']pg-(?:header|footer)["'][^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
  const re = /<(\/?)(section|div|nav|aside)\b([^>]*)>/gi;
  let out = "";
  let last = 0;
  let depth = 0;
  let dropping = false;
  let dropDepth = 0;
  let dropStart = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutPg))) {
    const closing = match[1] === "/";
    const attrs = match[3] || "";
    const selfClosing = /\/\s*$/.test(attrs);
    if (selfClosing) continue;
    if (!closing) {
      if (!dropping && dropsEpubType(epubTypes(attrs))) {
        out += withoutPg.slice(last, match.index);
        dropping = true;
        dropDepth = depth;
        dropStart = match.index;
      }
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
      if (dropping && depth === dropDepth) {
        last = re.lastIndex;
        dropping = false;
      }
    }
  }
  if (dropping) out += withoutPg.slice(dropStart);
  else out += withoutPg.slice(last);
  return out;
}

function isBoilerplateSpineHref(href: string): boolean {
  const name = href.split("/").pop()?.toLowerCase() || href.toLowerCase();
  return /^(?:nav|toc|cover|titlepage)(?:[._-]|\.|$)/.test(name);
}

// ── EPUB table of contents (NCX / nav) ────────────────────────────────

type EpubTocEntry = { label: string; href: string; level: number };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text of the element carrying `id`, or null. Used for `href#fragment` anchors. */
function elementTextById(html: string, id: string): string | null {
  const idMatch = new RegExp(`\\bid=["']?${escapeRegExp(id)}["']?(?:[\\s>])`, "i").exec(
    html
  );
  if (!idMatch) return null;
  const tagStart = html.lastIndexOf("<", idMatch.index);
  if (tagStart < 0) return null;
  const tagEnd = html.indexOf(">", tagStart);
  if (tagEnd < 0) return null;
  const openTag = html.slice(tagStart, tagEnd + 1);
  const name = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(openTag)?.[1];
  if (!name) return null;
  if (/\/\s*>$/.test(openTag)) return "";
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = tagEnd + 1;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const selfClosing = /\/\s*>$/.test(match[0]);
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return stripHtml(html.slice(tagEnd + 1, match.index)).trim();
      }
    } else if (!selfClosing) {
      depth += 1;
    }
  }
  return null;
}

/** First paragraph of a text blob, capped like a heading line. */
function firstParagraphOf(text: string): string {
  const first = normalizeExtractedText(text).split(/\n\s*\n/)[0] ?? "";
  return first.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** EPUB 2 NCX: navPoint nesting gives the level; content src the target. */
function parseNcxToc(ncx: string): EpubTocEntry[] {
  const out: EpubTocEntry[] = [];
  const re =
    /<navPoint\b[^>]*>|<\/navPoint>|<navLabel\b[^>]*>[\s\S]*?<\/navLabel>|<content\b[^>]*>/gi;
  let depth = 0;
  let label: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(ncx))) {
    const token = match[0];
    if (/^<navPoint\b/i.test(token)) {
      depth += 1;
      label = null;
      continue;
    }
    if (/^<\/navPoint/i.test(token)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (/^<navLabel\b/i.test(token)) {
      const text = /<text\b[^>]*>([\s\S]*?)<\/text>/i.exec(token)?.[1] ?? "";
      label = stripHtml(text).replace(/\s+/g, " ").trim();
      continue;
    }
    if (/^<content\b/i.test(token)) {
      const src = attr(token, "src");
      if (label && src) out.push({ label, href: src, level: Math.max(1, depth) });
      label = null;
    }
  }
  return out;
}

/** EPUB 3 nav document: the `toc` nav's <ol> nesting gives the level. */
function parseNavToc(html: string): EpubTocEntry[] {
  const navTags = html.match(/<nav\b[^>]*>/gi) ?? [];
  let navStart = -1;
  let openLen = 0;
  for (const tag of navTags) {
    const types = epubTypes(tag);
    if (!types.includes("toc")) continue;
    navStart = html.indexOf(tag);
    openLen = tag.length;
    break;
  }
  if (navStart < 0) return [];
  const closeRe = /<\/?nav\b[^>]*>/gi;
  closeRe.lastIndex = navStart + openLen;
  let depth = 1;
  let navEnd = html.length;
  let match: RegExpExecArray | null;
  while ((match = closeRe.exec(html))) {
    if (/\/\s*>$/.test(match[0])) continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) {
      navEnd = match.index;
      break;
    }
  }
  const body = html.slice(navStart + openLen, navEnd);
  const out: EpubTocEntry[] = [];
  const tokenRe = /<ol\b[^>]*>|<\/ol>|<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let level = 0;
  while ((match = tokenRe.exec(body))) {
    const token = match[0];
    if (/^<ol\b/i.test(token)) {
      level += 1;
      continue;
    }
    if (/^<\/ol/i.test(token)) {
      level = Math.max(0, level - 1);
      continue;
    }
    const href = attr(token, "href");
    const label = stripHtml(token.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (href && label) out.push({ label, href, level: Math.max(1, level) });
  }
  return out;
}

/** Read the book's TOC entries from the NCX or the EPUB 3 nav document. */
async function epubTocEntries(
  zip: { file(name: string): { async(type: "string"): Promise<string> } | null },
  opf: string,
  opfDir: string
): Promise<EpubTocEntry[]> {
  const readEntry = async (href: string): Promise<{ text: string; dir: string } | null> => {
    const full = opfDir + href;
    const entry = zip.file(full) || zip.file(decodeURIComponent(full));
    if (!entry) return null;
    try {
      const text = await entry.async("string");
      return text.trim() ? { text, dir: hrefDir(full) } : null;
    } catch {
      return null;
    }
  };
  const items = opf.match(/<item\b[^>]*>/gi) ?? [];
  for (const tag of items) {
    const props = (attr(tag, "properties") || "").toLowerCase().split(/\s+/);
    if (!props.includes("nav")) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    const doc = await readEntry(href);
    if (!doc) continue;
    const entries = parseNavToc(doc.text);
    if (entries.length > 0) {
      return entries.map((entry) => ({ ...entry, href: doc.dir + entry.href }));
    }
  }
  for (const tag of items) {
    const mediaType = (attr(tag, "media-type") || "").toLowerCase();
    if (mediaType !== "application/x-dtbncx+xml") continue;
    const href = attr(tag, "href");
    if (!href) continue;
    const doc = await readEntry(href);
    if (!doc) continue;
    const entries = parseNcxToc(doc.text);
    if (entries.length > 0) {
      return entries.map((entry) => ({ ...entry, href: doc.dir + entry.href }));
    }
  }
  return [];
}

/**
 * TOC entries become title hints. The display title is the TOC label; the
 * alignment anchor is the labelled element's text (for `href#id`), else the
 * first paragraph of the target spine document, with the label as a last
 * resort. Several entries may share one file — later duplicates align on
 * their label, since the file start is already taken by the first.
 */
function epubTocHints(
  entries: EpubTocEntry[],
  docsByPath: Map<string, { html: string; firstPara: string }>
): { title: string; level: number; anchors: string[] }[] {
  const out: { title: string; level: number; anchors: string[] }[] = [];
  const claimed = new Set<string>();
  for (const entry of entries.slice(0, MAX_OUTLINE_TITLES)) {
    const label = entry.label.replace(/\s+/g, " ").trim();
    if (!label || label.length > 160) continue;
    const [rawPath, fragment] = entry.href.split("#");
    const path = normalizeEpubHref("", rawPath ?? "");
    if (!path) continue;
    const doc = docsByPath.get(path);
    if (!doc) continue;
    const anchors: string[] = [];
    if (fragment) {
      let fragText: string | null = null;
      try {
        fragText = elementTextById(doc.html, decodeURIComponent(fragment));
      } catch {
        fragText = null;
      }
      const para = fragText ? firstParagraphOf(fragText) : "";
      if (para) anchors.push(para);
    }
    if (!claimed.has(path)) {
      if (doc.firstPara) anchors.push(doc.firstPara);
      claimed.add(path);
    }
    anchors.push(label);
    out.push({ title: label, level: entry.level, anchors: [...new Set(anchors)] });
  }
  return out;
}

async function extractEPUB(bytes: Uint8Array): Promise<ExtractedDocument> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }
  const rootMatch = containerXml.match(/full-path="([^"]+)"/i);
  const opfPath = rootMatch?.[1];
  if (!opfPath) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }
  const opfDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
    : "";
  const opf = await zip.file(opfPath)?.async("string");
  if (!opf) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }

  const hrefById = new Map<string, string>();
  for (const itemTag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(itemTag, "id");
    const href = attr(itemTag, "href");
    if (id && href) hrefById.set(id, href);
  }
  const spineIds = [
    ...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/gi),
  ]
    .map((m) => m[1])
    .filter((id): id is string => Boolean(id));

  const spineDocs: { href: string; html: string }[] = [];
  for (const id of spineIds) {
    const href = hrefById.get(id);
    if (!href) continue;
    const entry = zip.file(opfDir + href) || zip.file(decodeURIComponent(opfDir + href));
    if (!entry) continue;
    try {
      const html = await entry.async("string");
      if (html.trim()) spineDocs.push({ href, html });
    } catch {
      // Skip non-text spine entries.
    }
  }

  const dropHrefs = epubDropHrefs(opf, opfDir);
  for (const doc of spineDocs) {
    for (const href of epubDropHrefs(doc.html, opfDir + hrefDir(doc.href))) dropHrefs.add(href);
  }
  const hrefDropped = (href: string) => {
    const path = normalizeEpubHref(opfDir, href);
    return path != null && dropHrefs.has(path);
  };
  const withoutBoilerplate = spineDocs.filter((doc) => {
    if (isBoilerplateSpineHref(doc.href) || hrefDropped(doc.href)) return false;
    const body = doc.html.match(/<body\b[^>]*>/i)?.[0] || "";
    return !dropsEpubType(epubTypes(body));
  });
  const chosen =
    withoutBoilerplate.length > 0
      ? withoutBoilerplate
      : spineDocs.filter((doc) => !isBoilerplateSpineHref(doc.href));

  const titles: { title: string; level: number }[] = [];
  const chapters: string[] = [];
  const docsByPath = new Map<string, { html: string; firstPara: string }>();
  for (const doc of chosen) {
    const html = stripEpubFurniture(doc.html);
    const plain = stripHtml(html);
    if (plain.trim()) chapters.push(plain.trim());
    const path = normalizeEpubHref("", opfDir + doc.href);
    if (path && !docsByPath.has(path)) {
      docsByPath.set(path, { html, firstPara: firstParagraphOf(plain) });
    }
    titles.push(...htmlHeadings(html));
  }

  if (chapters.length === 0) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }

  const tocHints = epubTocHints(await epubTocEntries(zip, opf, opfDir), docsByPath);
  return {
    text: normalizeExtractedText(chapters.join("\n\n")),
    hint:
      tocHints.length >= 2
        ? { source: "epub-spine", titles: tocHints }
        : { source: "epub-spine", titles },
  };
}

type BufferPolyfill = {
  from(input: Uint8Array): unknown;
  isBuffer(value: unknown): boolean;
};

/**
 * Mammoth options for one DOCX.
 *
 * Always send a standalone `arrayBuffer` (`bytes.buffer.slice`). The extract
 * Worker bundles mammoth's browser unzip, which opens that key only and
 * throws "Could not find file in options" for `buffer`, `path`, or a
 * polyfill object. A Worker `Buffer` often exists while `Buffer.isBuffer`
 * is false; that object must not be the file input. Include `buffer` only
 * when `Buffer.isBuffer(Buffer.from(bytes))` is true, so Node unzip (Vercel
 * and tests) can open the file too. Never send `path`.
 */
export function mammothInput(bytes: Uint8Array): {
  arrayBuffer: ArrayBuffer;
  buffer?: Buffer;
} {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const polyfill = (globalThis as { Buffer?: Partial<BufferPolyfill> }).Buffer;
  if (
    !polyfill ||
    typeof polyfill.from !== "function" ||
    typeof polyfill.isBuffer !== "function"
  ) {
    return { arrayBuffer };
  }
  const buffer = polyfill.from(bytes);
  if (!polyfill.isBuffer(buffer)) return { arrayBuffer };
  return { arrayBuffer, buffer: buffer as Buffer };
}

// ── DOCX ───────────────────────────────────────────────────────────────

/**
 * DOCX headings: real h1–h3 (Heading styles, plus Title/Subtitle through the
 * style map) and, in document order, short fully-bold paragraphs — a common
 * way chapter lines are typed when no heading style is applied. Bold lines
 * only count when at least three appear, so scattered emphasis is not read
 * as structure.
 */
function docxHeadings(html: string): { title: string; level: number }[] {
  const tokenRe =
    /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>|<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi;
  const out: { title: string; level: number; bold: boolean }[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html))) {
    if (match[1]) {
      const title = stripHtml(match[2] ?? "").replace(/\s+/g, " ").trim();
      if (title && title.length <= 160) out.push({ title, level: Number(match[1]), bold: false });
      continue;
    }
    const title = stripHtml(match[3] ?? "").replace(/\s+/g, " ").trim();
    if (title.length < 2 || title.length > 80) continue;
    if (!/[A-Za-zÀ-ɏ]/.test(title)) continue;
    if (/[.!?…:]$/.test(title) || title.includes("?")) continue;
    out.push({ title, level: 2, bold: true });
  }
  const styled = out.filter((h) => !h.bold);
  const bold = out.filter((h) => h.bold);
  // Three or more heading styles are the outline. A title and a subtitle
  // alone must not hide chapter lines that were typed in bold.
  if (styled.length >= 3) return styled.map(({ title, level }) => ({ title, level }));
  if (bold.length >= 3) return out.map(({ title, level }) => ({ title, level }));
  return styled.map(({ title, level }) => ({ title, level }));
}

async function extractDOCX(bytes: Uint8Array): Promise<ExtractedDocument> {
  const mammoth = await import("mammoth");
  const input = mammothInput(bytes);
  try {
    const htmlResult = await mammoth.convertToHtml(input, {
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
    });
    const html = htmlResult.value || "";
    if (html.trim()) {
      const text = normalizeExtractedText(stripHtml(html));
      if (text.trim()) {
        return {
          text,
          hint: { source: "docx-heading", titles: docxHeadings(html) },
        };
      }
    }
  } catch {
    // Fall through to raw text. The upload still succeeds without headings.
  }

  const result = await mammoth.extractRawText(input);
  if (!result.value?.trim()) {
    throw new Error("Could not extract text from DOCX. The file may be empty or corrupted.");
  }

  return {
    text: normalizeExtractedText(result.value),
    hint: headingLinesHint(),
  };
}

// ── TXT ────────────────────────────────────────────────────────────────

function extractTXT(bytes: Uint8Array): Promise<ExtractedDocument> {
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.trim()) {
    throw new Error("The text file is empty.");
  }
  return Promise.resolve({
    text: normalizeExtractedText(text),
    hint: headingLinesHint(),
  });
}

// ── RTF ────────────────────────────────────────────────────────────────

function extractRTF(bytes: Uint8Array): Promise<ExtractedDocument> {
  const raw = new TextDecoder("utf-8").decode(bytes);

  // Strip RTF control words and braces — crude but effective for plain text extraction
  const text = raw
    .replace(/\\par[d]?/gi, "\n")
    .replace(/\\tab/gi, "\t")
    .replace(/\\line/gi, "\n")
    .replace(/\\[a-z]+\d*\s?/gi, "")   // control words
    .replace(/[{}]/g, "")               // braces
    .replace(/\\\\/g, "\\")             // escaped backslash
    .trim();

  if (!text.trim()) {
    throw new Error("Could not extract text from RTF. The file may be empty or corrupted.");
  }

  return Promise.resolve({
    text: normalizeExtractedText(text),
    hint: headingLinesHint(),
  });
}

// ── MOBI / AZW ─────────────────────────────────────────────────────────

async function extractMOBI(bytes: Uint8Array, fileName: string): Promise<ExtractedDocument> {
  // Calibre is Node-only. Cloudflare Workers (and Vercel without
  // ebook-convert) get a clear convert-first error — never child_process.
  let exec: typeof import("child_process").exec;
  let promisify: typeof import("util").promisify;
  let fs: typeof import("fs");
  let path: typeof import("path");
  let os: typeof import("os");
  try {
    ({ exec } = await import("child_process"));
    ({ promisify } = await import("util"));
    fs = await import("fs");
    path = await import("path");
    os = await import("os");
  } catch {
    throw new Error(
      "Use EPUB or PDF."
    );
  }

  const execAsync = promisify(exec);

  // Check if ebook-convert is available
  try {
    await execAsync("ebook-convert --version", { timeout: 5_000 });
  } catch {
    throw new Error(
      "Use EPUB or PDF."
    );
  }

  const tempDir = path.join(os.tmpdir(), `echomancer_mobi_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const inputPath = path.join(tempDir, fileName.replace(/[^a-zA-Z0-9._-]/g, "_"));
    const outputPath = path.join(tempDir, "output.txt");

    fs.writeFileSync(inputPath, Buffer.from(bytes));

    await execAsync(`ebook-convert "${inputPath}" "${outputPath}"`, {
      timeout: 60_000,
    });

    const text = fs.readFileSync(outputPath, "utf-8");
    if (!text.trim()) {
      throw new Error("ebook-convert produced empty output. The MOBI file may be DRM-protected.");
    }
    return {
      text: normalizeExtractedText(text),
      hint: headingLinesHint(),
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")             // strip remaining tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")              // numeric entities
    .replace(/\n{3,}/g, "\n\n")          // collapse excess newlines
    .trim();
}
