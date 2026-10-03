/**
 * Node extract of a multi-megabyte PDF. The Free-plan Cloudflare Worker
 * dies on a file this size; this is the path the Contabo worker runs
 * (in-process here, forked as `extract-child.ts` in production).
 */

import { describe, expect, it } from "vitest";
import { USER_A, resetDatabase, seedUpload, UPLOAD_ID_A } from "@/test/harness";
import { execute } from "@/lib/turso";

const PHRASE = "The harbour lamps burned through the fog while the tide turned";

function escapePdf(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** One page of body text, kept out of the running-header band. */
function pageStream(pageNo: number): string {
  const lines = [`Chapter ${pageNo}`];
  for (let i = 0; i < 32; i++) {
    lines.push(`Page ${pageNo} line ${i + 1}. ${PHRASE}.`);
  }
  const parts = ["BT", "/F1 11 Tf"];
  let y = 560;
  for (const line of lines) {
    parts.push(`1 0 0 1 72 ${y} Tm (${escapePdf(line)}) Tj`);
    y -= 12;
  }
  parts.push("ET");
  return `${parts.join("\n")}\n`;
}

/** Uncompressed text PDF. Page count grows until `minBytes`. */
export function buildLargeTextPdf(minBytes: number): Buffer {
  const estimate = Math.max(1, Math.ceil(minBytes / 2800));
  let pageCount = estimate;
  let pdf = assemble(pageCount);
  if (pdf.length < minBytes) {
    pageCount += Math.ceil((minBytes - pdf.length) / 2800) + 2;
    pdf = assemble(pageCount);
  }
  return pdf;
}

function assemble(pageCount: number): Buffer {
  const chunks: Buffer[] = [];
  let cursor = 0;
  const write = (value: string) => {
    const buf = Buffer.from(value, "latin1");
    chunks.push(buf);
    cursor += buf.length;
  };

  write("%PDF-1.4\n");
  const fontObj = 3;
  const pagesObj = 2;
  const firstPageObj = 4;
  const kids = Array.from(
    { length: pageCount },
    (_, i) => `${firstPageObj + i * 2} 0 R`
  ).join(" ");
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  for (let i = 0; i < pageCount; i++) {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    const stream = pageStream(i + 1);
    objects[pageObj] =
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentObj} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`;
    objects[contentObj] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
  }

  const maxObj = firstPageObj + pageCount * 2 - 1;
  const offsets = new Array<number>(maxObj + 1).fill(0);
  for (let id = 1; id <= maxObj; id++) {
    offsets[id] = cursor;
    write(`${id} 0 obj\n${objects[id]}\nendobj\n`);
  }
  const xrefAt = cursor;
  write(`xref\n0 ${maxObj + 1}\n`);
  write("0000000000 65535 f \n");
  for (let id = 1; id <= maxObj; id++) {
    write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  write(
    `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  );
  return Buffer.concat(chunks);
}

describe("node extract of a multi-megabyte PDF", () => {
  it("reads a small generated page", async () => {
    const { extractDocument } = await import("@/lib/text-extraction");
    const bytes = buildLargeTextPdf(1);
    const extracted = await extractDocument(bytes, "page.pdf", "application/pdf");
    expect(extracted.text).toContain("harbour lamps");
    expect(extracted.text).toContain("Chapter 1");
  });

  it("extracts a multi-megabyte PDF on the Node path", async () => {
    const bytes = buildLargeTextPdf(2 * 1024 * 1024);
    expect(bytes.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);

    await resetDatabase();
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "placeholder",
    });
    const { uploadFile, downloadFile } = await import("@/lib/storage");
    const sourcePath = `pdfs/${UPLOAD_ID_A}/source.pdf`;
    await uploadFile(
      `pdfs/${UPLOAD_ID_A}`,
      "source.pdf",
      bytes,
      "application/pdf"
    );
    await execute(
      `UPDATE uploads
         SET status = 'uploaded', source_path = ?, file_name = 'book.pdf',
             format = 'pdf', content_type = 'application/pdf',
             byte_size = ?, char_count = 0, error_message = NULL,
             extract_host = NULL, extract_attempts = 0
       WHERE id = ?`,
      [sourcePath, bytes.length, UPLOAD_ID_A]
    );

    const { extractUploadedDocument } = await import("@/lib/uploads/extract");
    const started = Date.now();
    const view = await extractUploadedDocument(UPLOAD_ID_A, { host: "node" });
    const ms = Date.now() - started;
    const pages = Number(/\/Count (\d+)/.exec(bytes.toString("latin1"))?.[1] || 0);
    console.info(
      `[extract-bench] bytes=${bytes.length} pages=${pages} chars=${view.charCount} ms=${ms} status=${view.status}`
    );

    expect(view.status).toBe("ready");
    expect(view.charCount).toBeGreaterThan(50_000);
    expect(ms).toBeLessThan(90_000);
    const stored = (await downloadFile(`pdfs/${UPLOAD_ID_A}/content.txt`)).toString(
      "utf8"
    );
    expect(stored).toContain("harbour lamps");
    const chapters = JSON.parse(
      (await downloadFile(`pdfs/${UPLOAD_ID_A}/chapters.json`)).toString("utf8")
    ) as { chapters: unknown[] };
    expect(Array.isArray(chapters.chapters)).toBe(true);
  }, 180_000);
});
