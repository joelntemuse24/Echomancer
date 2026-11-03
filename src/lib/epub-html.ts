/**
 * EPUB HTML helpers: hrefs, `epub:type` filtering, and furniture removal.
 *
 * Split out of `text-extraction.ts` so the block-based EPUB path can use them
 * without importing the whole extractor (which would be a cycle).
 */

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`, "i"));
  return match?.[1] ?? null;
}

export const EPUB_DROP_TYPES = new Set([
  "copyright-page",
  "toc",
  "index",
  "colophon",
  "loi",
  "lot",
  "imprint",
]);

export function epubTypes(tag: string): string[] {
  const raw = attr(tag, "epub:type") || attr(tag, "type") || "";
  return raw.toLowerCase().split(/\s+/).filter(Boolean);
}

export function dropsEpubType(types: string[]): boolean {
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

export function hrefDir(href: string): string {
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

/** A nav, contents, or cover file is not a chapter. */
export function isBoilerplateSpineHref(href: string): boolean {
  const name = href.split("/").pop()?.toLowerCase() || href.toLowerCase();
  return /^(?:nav|toc|cover|titlepage)(?:[._-]|\.|$)/.test(name);
}
