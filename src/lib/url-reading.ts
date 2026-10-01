/**
 * Decide whether a fetched page is something to narrate, and find the
 * full text when the URL is only the catalog page in front of it.
 */

const FULL_TEXT_MIN = 20_000;

const UI_LABEL =
  /\b(log in|sign up|sign in|my books|cookie|subscribe|javascript|verification failed|main menu|skip to content|enable javascript|checking your browser)\b/gi;

export function looksLikeSourceCode(sample: string): boolean {
  const text = sample.trim();
  if (text.length < 40) return false;
  const spaces = text.split(" ").length - 1;
  const symbols = text.match(/[{}();=<>]/g)?.length ?? 0;
  if (symbols > 12 && symbols > spaces) return true;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const codeLines = lines.filter((line) =>
    /^(?:function\b|const |let |var |import |export |class |return |if \(|for \()/.test(
      line
    )
  ).length;
  return lines.length >= 3 && codeLines >= 3 && codeLines >= lines.length * 0.4;
}

/** Drop paragraphs that are source, and flag a page that is only chrome. */
export function withoutSourceCode(text: string): string {
  const kept = text
    .split(/\n\s*\n/)
    .filter((paragraph) => !looksLikeSourceCode(paragraph));
  return kept.join("\n\n").trim();
}

export function isFrontendChrome(text: string): boolean {
  const sample = text.slice(0, 12_000);
  if (looksLikeSourceCode(sample)) return true;
  const lines = sample
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const longChars = lines
    .filter((line) => line.length >= 80)
    .reduce((total, line) => total + line.length, 0);
  const uiHits = sample.match(UI_LABEL)?.length ?? 0;
  if (lines.length >= 6 && longChars < 400 && uiHits >= 2) return true;
  if (uiHits >= 4 && longChars < sample.length * 0.25) return true;
  return false;
}

export function shouldFollowFullText(text: string): boolean {
  return text.length < FULL_TEXT_MIN || isFrontendChrome(text);
}

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

function attrValue(raw: string, name: string): string {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i"
  ).exec(raw);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replace(/&amp;/gi, "&");
}

function sameSite(a: URL, b: URL): boolean {
  const host = (value: string) => value.replace(/^www\./, "").toLowerCase();
  return host(a.hostname) === host(b.hostname);
}

function scoreFullTextLink(url: URL, label: string): number {
  const path = `${url.pathname}${url.search}`.toLowerCase();
  if (
    path.includes("/help/") ||
    path.includes("/policy/") ||
    path.includes("/send/") ||
    path.endsWith(".zip") ||
    path.includes(".kindle") ||
    path.includes(".epub")
  ) {
    return 0;
  }
  const text = label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (path.includes(".txt.utf-8") || text === "plain text" || text.startsWith("plain text")) {
    return 100;
  }
  if (/\.txt(?:$|\?)/.test(path) || path.endsWith(".text")) return 90;
  if (text.includes("read online") && /\.html?$/.test(path)) return 60;
  if (/\/pg\d+/.test(path) && /\.html?$/.test(path)) return 50;
  return 0;
}

/** The plain-text or read-online file linked from a catalog page. */
export function findFullTextLink(html: string, base: URL): URL | null {
  const source = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  let best: { score: number; url: URL } | null = null;
  let index = 0;
  const lower = source.toLowerCase();
  while (index < source.length) {
    const lt = lower.indexOf("<a", index);
    if (lt === -1) break;
    const boundary = source[lt + 2];
    if (boundary && /[a-z0-9]/i.test(boundary)) {
      index = lt + 2;
      continue;
    }
    const gt = findTagEnd(source, lt);
    if (gt === -1) break;
    const href = attrValue(source.slice(lt, gt + 1), "href");
    const close = lower.indexOf("</a", gt);
    const label = close === -1 ? "" : source.slice(gt + 1, close);
    index = close === -1 ? gt + 1 : close + 3;
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (!sameSite(url, base)) continue;
    const score = scoreFullTextLink(url, label);
    if (score > 0 && (!best || score > best.score)) best = { score, url };
  }
  if (best && best.url.href === base.href) return null;
  return best?.url ?? null;
}

const GUTENBERG_START =
  /\*\*\*\s*START OF (?:THE |THIS )?PROJECT GUTENBERG EBOOK\s+([^*]+?)\s*\*\*\*/i;
const GUTENBERG_END =
  /\*\*\*\s*END OF (?:THE |THIS )?PROJECT GUTENBERG EBOOK\b/i;
const GUTENBERG_HEADER = /^the project gutenberg ebook of\s+(.+)$/im;

function tidyTitle(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;
  if (cleaned === cleaned.toUpperCase() && /[A-Z]/.test(cleaned)) {
    return cleaned
      .toLowerCase()
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  }
  return cleaned.slice(0, 200);
}

export function prepareFetchedBook(
  text: string,
  title: string | null
): { text: string; title: string | null } {
  const marker = text.match(GUTENBERG_START);
  const header = text.match(GUTENBERG_HEADER);
  const bookTitle = tidyTitle(marker?.[1] || header?.[1] || "");
  let body = text;
  if (marker && marker.index !== undefined) {
    body = text.slice(marker.index + marker[0].length);
    const end = body.search(GUTENBERG_END);
    if (end !== -1) body = body.slice(0, end);
    body = body.trim();
    if (body.length < 50) body = text.trim();
  }
  return {
    text: body,
    title: title?.trim() || bookTitle || null,
  };
}
