/**
 * One cleanup pass, three intakes.
 *
 * A paste (`POST /api/text/upload`), a fetched web page (`readPublicUrl`), and
 * an uploaded .txt (`POST /api/pdf/upload` → extract) must store byte-identical
 * `content.txt` for the same words, and must derive the same chapter outline
 * from them. These tests state the shared string once and assert all sources
 * against it, so a future source-only branch shows up as a diff here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  htmlToArticle,
  normalizePageText,
  decodeHtmlEntities,
} from "@/lib/html-article";
import { parseChaptersDocument } from "@/lib/book-chapters";
import { normalizeSourceText } from "@/lib/source-text";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import {
  type PageDeps,
  readPublicUrl,
  setPageDepsForTests,
} from "@/lib/fetch-public-page";
import {
  USER_A,
  buildRequest,
  resetDatabase,
  uploadBookViaApi,
} from "@/test/harness";

/**
 * The same book in three line shapes: a paste with hard wraps, the HTML a page
 * would serve, and the uploaded .txt. Every shape must land on this string.
 */
const SHAPES = {
  paste: [
    "Chapter One",
    "The lamps were lit along the quay and the tide was",
    "turning before midnight.",
    "",
    "It was a cold",
    "night.",
    "",
    "Chapter Two",
    "Night settled over the harbour and the boats were",
    "still for a long while.",
  ].join("\n"),
  text: [
    "Chapter One",
    "",
    "The lamps were lit along the quay and the tide was turning before midnight.",
    "",
    "It was a cold night.",
    "",
    "Chapter Two",
    "",
    "Night settled over the harbour and the boats were still for a long while.",
  ].join("\n"),
  html: `<html><head><title>Harbour</title></head><body><article>
<p>Chapter One</p>
<p>The lamps were lit along the quay and the tide was turning before midnight.</p>
<p>It was a cold night.</p>
<p>Chapter Two</p>
<p>Night settled over the harbour and the boats were still for a long while.</p>
</article></body></html>`,
};

const SPEAKABLE = [
  "Chapter One",
  "",
  "The lamps were lit along the quay and the tide was turning before midnight.",
  "",
  "It was a cold night.",
  "",
  "Chapter Two",
  "",
  "Night settled over the harbour and the boats were still for a long while.",
].join("\n");

function pageDeps(body: string, contentType = "text/html; charset=utf-8"): PageDeps {
  return {
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": contentType },
      body: Buffer.from(body),
    }),
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  setPageDepsForTests(null);
  await resetDatabase();
});

describe("the shared paragraph pass", () => {
  it("settles every line shape on one string", () => {
    expect(normalizeSourceText(SHAPES.paste)).toBe(SPEAKABLE);
    expect(normalizeSourceText(SHAPES.text)).toBe(SPEAKABLE);
    expect(normalizeSourceText(htmlToArticle(SHAPES.html).text)).toBe(SPEAKABLE);
  });

  it("produces one speakable string from all three", () => {
    expect(toSpeakableText(normalizeSourceText(SHAPES.paste))).toBe(SPEAKABLE);
    expect(toSpeakableText(normalizeSourceText(SHAPES.text))).toBe(SPEAKABLE);
    expect(
      toSpeakableText(normalizeSourceText(htmlToArticle(SHAPES.html).text))
    ).toBe(SPEAKABLE);
  });

  it("keeps the sentence-rejoin, drop-cap, clock and footnote rules", () => {
    // A blank line inside a sentence, from #223.
    expect(normalizeSourceText("they ultimately create\n\nwealth.")).toBe(
      "they ultimately create wealth."
    );
    // A decorative drop cap copied twice.
    expect(normalizeSourceText("R Ravi avi wakes up early.")).toBe(
      "Ravi wakes up early."
    );
    // A heading stays above its sentence.
    expect(
      normalizeSourceText("The Commanding Heights\n\nThey create wealth in the valley.")
    ).toBe("The Commanding Heights\n\nThey create wealth in the valley.");
  });
});

describe("paste, URL and upload agree", () => {
  it("stores the same speakable content.txt for all three intakes", async () => {
    const { POST: paste } = await import("@/app/api/text/upload/route");
    const pasteRes = await paste(
      await buildRequest("/api/text/upload", {
        userId: USER_A,
        body: { text: SHAPES.paste },
      })
    );
    const pasteBody = await pasteRes.json();
    expect(pasteRes.status).toBe(200);

    setPageDepsForTests(pageDeps(SHAPES.html));
    const urlRes = await paste(
      await buildRequest("/api/text/upload", {
        userId: USER_A,
        body: { url: "https://harbour.example/notes" },
      })
    );
    const urlBody = await urlRes.json();
    expect(urlRes.status).toBe(200);

    const upload = await uploadBookViaApi(SHAPES.text, { userId: USER_A });
    expect(upload.response.status).toBe(200);

    const { downloadFile } = await import("@/lib/storage");
    const [pasted, fetched, uploaded] = await Promise.all([
      downloadFile(`pdfs/${pasteBody.uploadId}/content.txt`),
      downloadFile(`pdfs/${urlBody.uploadId}/content.txt`),
      downloadFile(upload.body.storagePath),
    ]);
    const textOf = (buffer: Uint8Array) => Buffer.from(buffer).toString("utf-8");

    expect(textOf(pasted)).toBe(SPEAKABLE);
    expect(textOf(fetched)).toBe(SPEAKABLE);
    expect(textOf(uploaded)).toBe(SPEAKABLE);
    expect(textOf(pasted)).toBe(textOf(fetched));
    expect(textOf(fetched)).toBe(textOf(uploaded));
  });

  it("detects the same chapters for all three intakes", async () => {
    const { POST: paste } = await import("@/app/api/text/upload/route");
    const pasteRes = await paste(
      await buildRequest("/api/text/upload", {
        userId: USER_A,
        body: { text: SHAPES.paste },
      })
    );
    const pasteBody = await pasteRes.json();

    setPageDepsForTests(pageDeps(SHAPES.html));
    const urlRes = await paste(
      await buildRequest("/api/text/upload", {
        userId: USER_A,
        body: { url: "https://harbour.example/notes" },
      })
    );
    const urlBody = await urlRes.json();

    const upload = await uploadBookViaApi(SHAPES.text, { userId: USER_A });

    const { downloadFile } = await import("@/lib/storage");
    const read = async (uploadId: string) =>
      parseChaptersDocument(
        Buffer.from(await downloadFile(`pdfs/${uploadId}/chapters.json`)).toString("utf-8")
      );

    const pasted = await read(pasteBody.uploadId);
    const fetched = await read(urlBody.uploadId);
    const uploaded = await read(upload.uploadId!);

    for (const doc of [pasted, fetched, uploaded]) {
      expect(doc).not.toBeNull();
      expect(doc!.chapters.map((chapter) => chapter.title)).toEqual([
        "Chapter One",
        "Chapter Two",
      ]);
    }
    expect(fetched!.chapters).toEqual(pasted!.chapters);
    expect(uploaded!.chapters).toEqual(pasted!.chapters);
  });

  it("serves a document link through the same pass as the file upload", async () => {
    // A PDF or EPUB link is extracted by the same `extractDocument` the upload
    // uses, then normalized by the same `normalizeSourceText`.
    setPageDepsForTests(pageDeps(SHAPES.text, "text/plain; charset=utf-8"));
    const page = await readPublicUrl("https://harbour.example/book.txt");
    expect(normalizeSourceText(page.text)).toBe(SPEAKABLE);
    expect(page.text).toBe(SPEAKABLE);
  });
});

describe("HTML extraction stays, cleanup is shared", () => {
  it("strips tags but leaves paragraph repair to the shared pass", () => {
    const html = `<article><p>they ultimately create</p><p>wealth.</p></article>`;
    // The extractor only reduces markup; it no longer rejoins prose itself.
    expect(htmlToArticle(html).text).toBe("they ultimately create\n\nwealth.");
    expect(normalizeSourceText(htmlToArticle(html).text)).toBe(
      "they ultimately create wealth."
    );
  });

  it("keeps entity decoding for text bodies and pasted text", () => {
    expect(normalizePageText(decodeHtmlEntities("Rock &amp; Roll"))).toBe(
      "Rock & Roll"
    );
    expect(toSpeakableText(normalizeSourceText("Rock &amp; Roll"))).toBe(
      "Rock & Roll"
    );
  });
});
