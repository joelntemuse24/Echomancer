import { describe, expect, it } from "vitest";
import { extractDocument } from "@/lib/text-extraction";
import { resolveChapters, safeResolveChapters } from "@/lib/book-chapters";
import { toSpeakableText } from "@/lib/tts/speakable-text";

/**
 * Each input type's own structure, read through the real extractor.
 *
 * These are per-format assertions on the *contract* the rest of the pipeline
 * relies on: `extractDocument` returns blocks whose markers are block indexes,
 * and `resolveChapters` turns those into an outline without searching prose.
 */

function chaptersOf(extracted: Awaited<ReturnType<typeof extractDocument>>) {
  const spoken = toSpeakableText(extracted.text, { normalizeTitles: false });
  const doc = resolveChapters(spoken, {
    ...extracted.hint,
    ...(extracted.blocks ? { blocks: extracted.blocks } : {}),
    ...(extracted.blockStart ? { blockStart: extracted.blockStart } : {}),
    ...(extracted.outline ? { blockOutline: extracted.outline } : {}),
  });
  return { spoken, doc };
}

describe("EPUB: the nav/NCX TOC is the outline", () => {
  it("maps each TOC fragment to its own block, not the file's first", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    );
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="b" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quay</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="book.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>`
    );
    zip.file(
      "OEBPS/nav.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
        <li><a href="book.xhtml#one">Chapter One</a></li>
        <li><a href="book.xhtml#two">Chapter Two</a></li>
        <li><a href="book.xhtml#three">Chapter Three</a></li>
      </ol></nav></body></html>`
    );
    zip.file(
      "OEBPS/book.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <section id="one"><h1>Chapter One</h1><p>The lamps were lit along the quay and the tide was turning before midnight.</p></section>
        <section id="two"><h1>Chapter Two</h1><p>Night settled over the harbour and the boats were still for a long while.</p></section>
        <section id="three"><h1>Chapter Three</h1><p>The return brought the boat back into the harbour before the morning came.</p></section>
      </body></html>`
    );
    const extracted = await extractDocument(
      Buffer.from(await zip.generateAsync({ type: "uint8array" })),
      "quay.epub",
      "application/epub+zip"
    );
    expect(extracted.blocks?.length).toBeGreaterThan(0);
    const { spoken, doc } = chaptersOf(extracted);
    expect(doc.source).toBe("epub-spine");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter Three",
    ]);
    // Each marker opens its own section, not the first one three times over.
    for (const chapter of doc.chapters) {
      expect(spoken.slice(chapter.charStart)).toMatch(/^Chapter (One|Two|Three)/);
    }
  });

  it("filters a cover, a title page, and a contents page out of the outline", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    );
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="b" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quay</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="book.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>`
    );
    zip.file(
      "OEBPS/nav.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
        <li><a href="book.xhtml#cover">Cover</a></li>
        <li><a href="book.xhtml#title">Titlepage</a></li>
        <li><a href="book.xhtml#contents">Contents</a></li>
        <li><a href="book.xhtml#one">Chapter One</a></li>
        <li><a href="book.xhtml#two">Chapter Two</a></li>
      </ol></nav></body></html>`
    );
    zip.file(
      "OEBPS/book.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <section id="cover"><p>COVER</p></section>
        <section id="title"><h1>Quay</h1><p>A novel</p></section>
        <section id="contents"><h1>Contents</h1><p>Chapter One</p><p>Chapter Two</p></section>
        <section id="one"><h1>Chapter One</h1><p>The lamps were lit along the quay and the tide was turning before midnight.</p></section>
        <section id="two"><h1>Chapter Two</h1><p>Night settled over the harbour and the boats were still for a long while.</p></section>
      </body></html>`
    );
    const extracted = await extractDocument(
      Buffer.from(await zip.generateAsync({ type: "uint8array" })),
      "quay.epub",
      "application/epub+zip"
    );
    const { doc } = chaptersOf(extracted);
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
    ]);
  });
});

describe("DOCX: heading styles stay the outline", () => {
  it("keeps Heading 1 lines and their order", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    );
    zip.file(
      "word/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>`
    );
    const heading = (text: string) =>
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const body = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        ${heading("Foreword")}
        ${body("The lamps were lit along the quay and the tide was turning before midnight.")}
        ${heading("Chapter One")}
        ${body("Night settled over the harbour and the boats were still for a long while.")}
        ${heading("Chapter Two")}
        ${body("The return brought the boat back into the harbour before the morning came.")}
      </w:body></w:document>`
    );
    const extracted = await extractDocument(
      await zip.generateAsync({ type: "nodebuffer" }),
      "quay.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(extracted.hint.source).toBe("docx-heading");
    const { doc } = chaptersOf(extracted);
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Foreword",
      "Chapter One",
      "Chapter Two",
    ]);
  });
});

describe("plain text: heuristics only, and printed contents may not replace them", () => {
  const BOOK = [
    "Contents",
    "",
    "   I.     The First Thing",
    "   II.    The Second Thing",
    "",
    "I. THE FIRST THING",
    "",
    "To Sherlock Holmes she is always the woman. I have seldom heard him mention her under any other name.",
    "",
    "II. THE SECOND THING",
    "",
    "I had called upon my friend one day and he was glad to see me after some time away.",
  ].join("\n");

  it("keeps the body's own headings", async () => {
    const extracted = await extractDocument(Buffer.from(BOOK, "utf-8"), "book.txt");
    const { doc } = chaptersOf(extracted);
    expect(doc.source).toBe("heading-lines");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "I. The First Thing",
      "II. The Second Thing",
    ]);
  });

  it("strips the Gutenberg header and footer before detection", async () => {
    const raw = [
      "The Project Gutenberg eBook of Book",
      "",
      "*** START OF THE PROJECT GUTENBERG EBOOK BOOK ***",
      "",
      BOOK,
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK BOOK ***",
      "",
      "Section 1. General Terms of Use and Redistributing Project",
      "",
      "Section 2. Information about the Mission of Project Gutenberg",
      "",
      "Section 3. Information about the Project Gutenberg Literary",
      "",
      "Section 4. Information about Donations to the Project Gutenberg",
      "",
      "Section 5. General Information About Project Gutenberg",
    ].join("\n");
    const extracted = await extractDocument(Buffer.from(raw, "utf-8"), "book.txt");
    const { doc } = chaptersOf(extracted);
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "I. The First Thing",
      "II. The Second Thing",
    ]);
  });

  it("gives an unmarked book labelled parts instead of headlines", async () => {
    const para = "The river ran past the mill and the miller said nothing at all. ".repeat(20);
    const shouted = Array.from({ length: 40 }, (_, i) => `HEADLINE NUMBER ${i + 1}`).join("\n\n");
    const raw = `${shouted}\n\n${para.repeat(40)}`;
    const extracted = await extractDocument(Buffer.from(raw, "utf-8"), "unmarked.txt");
    const spoken = toSpeakableText(extracted.text, { normalizeTitles: false });
    const doc = safeResolveChapters(spoken, extracted.hint);
    expect(doc.source).toBe("sections");
    expect(doc.chapters.every((chapter) => /^Part \d+$/.test(chapter.title))).toBe(true);
  });
});
