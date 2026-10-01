/**
 * Read a public web page into plain text for the paste intake.
 *
 * DNS is resolved first. Every address has to be public, and the connection
 * uses that address, so a later DNS answer cannot steer the request onto a
 * private host. Redirects are checked the same way.
 */

import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";
import {
  decodeHtmlEntities,
  htmlToArticle,
  normalizePageText,
} from "@/lib/html-article";
import { URL_MAX_BYTES, URL_MAX_CHARS } from "@/lib/paste-limits";
import {
  PublicUrlError,
  checkPublicHttpUrl,
  isBlockedAddress,
  stripUrlHost,
} from "@/lib/public-url";
import { MIN_EXTRACTED_CHARS } from "@/lib/document-formats";
import { extractTextFromDocument } from "@/lib/text-extraction";
import {
  findFullTextLink,
  isFrontendChrome,
  prepareFetchedBook,
  shouldFollowFullText,
  withoutSourceCode,
} from "@/lib/url-reading";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const EMPTY_MESSAGE = "That page didn't have enough text to narrate.";
const CHROME_MESSAGE =
  "That page looks like a website, not something to read. Paste the text instead.";
const TOO_LARGE_MESSAGE = "That page is too long to read from a link.";
const UNREACHABLE_MESSAGE = "Couldn't reach that page.";
const UNREADABLE_MESSAGE = "Couldn't read that page.";
const UNSUPPORTED_MESSAGE = "Couldn't read that page. Paste the text instead.";

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type PageRequest = {
  url: URL;
  ip: string;
  family: 4 | 6;
};

export type PageResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export type PageDeps = {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  request: (input: PageRequest) => Promise<PageResponse>;
};

export type PublicPageText = {
  text: string;
  title: string | null;
};

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string
): string {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

function unreachable(error?: unknown): PublicUrlError {
  if (error instanceof PublicUrlError) return error;
  return new PublicUrlError("URL_UNREACHABLE", UNREACHABLE_MESSAGE);
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const host = stripUrlHost(hostname);
  const kind = isIP(host);
  if (kind === 4 || kind === 6) return [{ address: host, family: kind }];
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => ({
      address: record.address,
      family: record.family === 6 ? 6 : 4,
    }));
  } catch (error) {
    throw unreachable(error);
  }
}

export function requestPublic(input: PageRequest): Promise<PageResponse> {
  const target = input.url;
  const isHttps = target.protocol === "https:";
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(
        error instanceof PublicUrlError
          ? error
          : new PublicUrlError("URL_UNREACHABLE", UNREACHABLE_MESSAGE)
      );
    };
    const succeed = (value: PageResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = lib.request(
      {
        host: input.ip,
        port: target.port
          ? Number(target.port)
          : isHttps
            ? 443
            : 80,
        method: "GET",
        path: `${target.pathname || "/"}${target.search}`,
        servername: isHttps ? stripUrlHost(target.hostname) : undefined,
        headers: {
          Host: target.host,
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Language": "en",
        },
      },
      (res) => {
        const length = Number(res.headers["content-length"] || "");
        if (Number.isFinite(length) && length > URL_MAX_BYTES) {
          res.resume();
          fail(new PublicUrlError("URL_TOO_LARGE", TOO_LARGE_MESSAGE));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > URL_MAX_BYTES) {
            fail(new PublicUrlError("URL_TOO_LARGE", TOO_LARGE_MESSAGE));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          succeed({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", fail);
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => fail(unreachable()));
    req.on("error", fail);
    req.end();
  });
}

const defaultPageDeps: PageDeps = {
  lookup: defaultLookup,
  request: requestPublic,
};

let pageDeps: PageDeps = defaultPageDeps;

/** Tests swap the DNS and HTTP steps. Production always uses the defaults. */
export function setPageDepsForTests(next: PageDeps | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Page fetch overrides are only available in tests.");
  }
  pageDeps = next ?? defaultPageDeps;
}

function inflate(body: Buffer, encoding: string): Buffer {
  const enc = encoding.toLowerCase().trim();
  if (!enc || enc === "identity") return body;
  if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(body);
  if (enc === "deflate") {
    try {
      return zlib.inflateSync(body);
    } catch {
      return zlib.inflateRawSync(body);
    }
  }
  if (enc === "br") return zlib.brotliDecompressSync(body);
  throw new PublicUrlError("URL_UNSUPPORTED", UNSUPPORTED_MESSAGE);
}

function sniffCharset(body: Buffer, contentType: string): string {
  const header = /charset\s*=\s*"?([a-z0-9._-]+)/i.exec(contentType)?.[1];
  if (header) return header;
  const head = body.subarray(0, 4096).toString("latin1");
  return /charset\s*=\s*["']?\s*([a-z0-9._-]+)/i.exec(head)?.[1] || "utf-8";
}

function decodeBuffer(body: Buffer, contentType: string): string {
  const label = sniffCharset(body, contentType)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  try {
    return new TextDecoder(label || "utf-8", { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

function classifyBody(
  contentType: string,
  body: Buffer,
  pageUrl?: URL
): "html" | "text" | "document" | "no" {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "application/html"
  ) {
    return "html";
  }
  if (mime === "text/plain" || mime === "text/markdown") return "text";
  if (mime === "text/xml" || mime === "application/xml" || mime === "application/rss+xml") {
    return "html";
  }
  if (
    mime === "application/pdf" ||
    mime === "application/epub+zip" ||
    mime === "application/x-mobipocket-ebook" ||
    mime === "application/rtf" ||
    mime === "text/rtf" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "document";
  }
  const path = pageUrl?.pathname.toLowerCase() ?? "";
  if (/\.(pdf|epub|docx|mobi|rtf)$/.test(path)) return "document";
  if (mime.startsWith("text/")) return "text";
  if (
    mime &&
    mime !== "application/octet-stream" &&
    mime !== "binary/octet-stream"
  ) {
    return "no";
  }
  const head = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("<article")
  ) {
    return "html";
  }
  if (body.subarray(0, 1024).includes(0)) return "no";
  return "text";
}

function fileNameFromUrl(url: URL, contentType: string): string {
  const last = decodeURIComponent(url.pathname.split("/").pop() || "");
  if (/\.[a-z0-9]{1,8}$/i.test(last)) return last;
  if (contentType.includes("pdf")) return "book.pdf";
  if (contentType.includes("epub")) return "book.epub";
  if (contentType.includes("wordprocessingml")) return "book.docx";
  return "book.bin";
}

function shapePage(text: string, title: string | null): PublicPageText {
  const prepared = prepareFetchedBook(withoutSourceCode(text), title);
  if (prepared.text.length > URL_MAX_CHARS) {
    throw new PublicUrlError("URL_TOO_LARGE", TOO_LARGE_MESSAGE);
  }
  return prepared;
}

function assertNarratable(page: PublicPageText): PublicPageText {
  if (isFrontendChrome(page.text)) {
    throw new PublicUrlError("URL_EMPTY", CHROME_MESSAGE);
  }
  if (page.text.length < MIN_EXTRACTED_CHARS) {
    throw new PublicUrlError("URL_EMPTY", EMPTY_MESSAGE);
  }
  return page;
}

async function textFromResponse(
  response: PageResponse,
  pageUrl: URL
): Promise<PublicPageText & { html: string | null }> {
  let body = response.body;
  try {
    body = inflate(body, headerValue(response.headers, "content-encoding"));
  } catch (error) {
    if (error instanceof PublicUrlError) throw error;
    throw new PublicUrlError("URL_UNSUPPORTED", UNSUPPORTED_MESSAGE);
  }
  if (body.length > URL_MAX_BYTES) {
    throw new PublicUrlError("URL_TOO_LARGE", TOO_LARGE_MESSAGE);
  }

  const contentType = headerValue(response.headers, "content-type");
  const kind = classifyBody(contentType, body, pageUrl);
  if (kind === "no") {
    throw new PublicUrlError("URL_UNSUPPORTED", UNSUPPORTED_MESSAGE);
  }

  if (kind === "document") {
    let extracted = "";
    try {
      extracted = await extractTextFromDocument(
        body,
        fileNameFromUrl(pageUrl, contentType),
        contentType
      );
    } catch {
      throw new PublicUrlError("URL_UNSUPPORTED", UNSUPPORTED_MESSAGE);
    }
    return {
      ...shapePage(normalizePageText(extracted), null),
      html: null,
    };
  }

  const decoded = decodeBuffer(body, contentType).replace(/^\uFEFF/, "");
  const article =
    kind === "html"
      ? htmlToArticle(decoded)
      : { title: null, text: normalizePageText(decodeHtmlEntities(decoded)) };
  return {
    ...shapePage(article.text, article.title),
    html: kind === "html" ? decoded : null,
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function resolvePublic(
  hostname: string,
  deps: PageDeps
): Promise<ResolvedAddress[]> {
  let records: ResolvedAddress[];
  try {
    records = await deps.lookup(stripUrlHost(hostname));
  } catch (error) {
    throw unreachable(error);
  }
  if (records.length === 0) {
    throw new PublicUrlError("URL_UNREACHABLE", UNREACHABLE_MESSAGE);
  }
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new PublicUrlError("URL_BLOCKED", "That link can't be read.");
    }
  }
  return records;
}

async function fetchOnce(url: URL, deps: PageDeps): Promise<PageResponse> {
  const records = await resolvePublic(url.hostname, deps);
  let lastError: PublicUrlError | null = null;
  for (const record of records.slice(0, 2)) {
    try {
      return await deps.request({
        url,
        ip: record.address,
        family: record.family,
      });
    } catch (error) {
      if (error instanceof PublicUrlError && error.code === "URL_TOO_LARGE") {
        throw error;
      }
      lastError = unreachable(error);
    }
  }
  throw lastError ?? new PublicUrlError("URL_UNREACHABLE", UNREACHABLE_MESSAGE);
}

export async function readPublicUrl(
  raw: string,
  deps: PageDeps = pageDeps,
  depth = 0
): Promise<PublicPageText> {
  const first = checkPublicHttpUrl(raw);
  if (!first.ok) throw new PublicUrlError(first.code, first.message);

  let current = first.url;
  const seen = new Set<string>();

  for (let redirect = 0; ; redirect += 1) {
    if (seen.has(current.href)) {
      throw new PublicUrlError("URL_UNREACHABLE", UNREADABLE_MESSAGE);
    }
    seen.add(current.href);

    const response = await fetchOnce(current, deps);
    if (!isRedirect(response.status)) {
      if (response.status < 200 || response.status >= 300) {
        throw new PublicUrlError("URL_UNREACHABLE", UNREADABLE_MESSAGE);
      }
      const page = await textFromResponse(response, current);
      if (depth === 0 && page.html && shouldFollowFullText(page.text)) {
        const link = findFullTextLink(page.html, current);
        if (link) {
          try {
            const followed = await readPublicUrl(link.href, deps, depth + 1);
            if (!isFrontendChrome(followed.text)) {
              return assertNarratable({
                text: followed.text,
                title: page.title || followed.title,
              });
            }
          } catch (error) {
            if (
              error instanceof PublicUrlError &&
              error.code !== "URL_EMPTY" &&
              error.code !== "URL_UNSUPPORTED"
            ) {
              throw error;
            }
          }
        }
      }
      return assertNarratable(page);
    }
    if (redirect >= MAX_REDIRECTS) {
      throw new PublicUrlError("URL_UNREACHABLE", UNREADABLE_MESSAGE);
    }
    const location = headerValue(response.headers, "location");
    if (!location) {
      throw new PublicUrlError("URL_UNREACHABLE", UNREADABLE_MESSAGE);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new PublicUrlError("INVALID_URL", "Paste a full http or https link.");
    }
    const checked = checkPublicHttpUrl(next.href);
    if (!checked.ok) throw new PublicUrlError(checked.code, checked.message);
    current = checked.url;
  }
}
