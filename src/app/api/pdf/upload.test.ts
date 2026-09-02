/**
 * Document upload contract: JSON presign, PUT bytes to storage, extract off
 * the Vercel request body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "@/lib/auth/session";
import {
  USER_A,
  buildRequest,
  resetDatabase,
  routeParams,
  uploadBookViaApi,
} from "@/test/harness";

const BOOK = "The lamps were lit along the quay. ".repeat(40);

beforeEach(async () => {
  vi.restoreAllMocks();
  delete process.env.TRIGGER_SECRET_KEY;
  delete process.env.VERCEL_ENV;
  await resetDatabase();
});

describe("POST /api/pdf/upload (presign)", () => {
  it("mints a session and returns a PUT target without touching the file bytes", async () => {
    const extract = await import("@/lib/text-extraction");
    const spy = vi.spyOn(extract, "extractTextFromDocument");

    const { POST } = await import("@/app/api/pdf/upload/route");
    const response = await POST(
      await buildRequest("/api/pdf/upload", {
        userId: null,
        body: {
          fileName: "book.txt",
          contentType: "text/plain",
          byteSize: BOOK.length,
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.uploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(body.putUrl).toBe(`/api/pdf/upload/${body.uploadId}/object`);
    expect(body.putHeaders["Content-Type"]).toBe("text/plain");
    expect(body.storagePath).toBe(`pdfs/${body.uploadId}/content.txt`);
    expect(spy).not.toHaveBeenCalled();

    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
  });

  it("rejects multipart bodies so the file cannot enter the function payload", async () => {
    const { POST } = await import("@/app/api/pdf/upload/route");
    const formData = new FormData();
    formData.append(
      "file",
      new File([BOOK], "book.txt", { type: "text/plain" }),
      "book.txt"
    );
    const response = await POST(
      await buildRequest("/api/pdf/upload", {
        method: "POST",
        formData,
        userId: USER_A,
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("USE_PRESIGN");
  });

  it("rejects a declared size over the product ceiling", async () => {
    const previous = process.env.MAX_UPLOAD_MB;
    process.env.MAX_UPLOAD_MB = "0.001";
    try {
      const { POST } = await import("@/app/api/pdf/upload/route");
      const response = await POST(
        await buildRequest("/api/pdf/upload", {
          userId: USER_A,
          body: {
            fileName: "book.txt",
            contentType: "text/plain",
            byteSize: 2000,
          },
        })
      );
      expect(response.status).toBe(413);
      expect((await response.json()).code).toBe("FILE_TOO_LARGE");
    } finally {
      if (previous === undefined) delete process.env.MAX_UPLOAD_MB;
      else process.env.MAX_UPLOAD_MB = previous;
    }
  });
});

describe("PUT + complete + extract", () => {
  it("extracts from stored bytes and records ownership", async () => {
    const { response, body } = await uploadBookViaApi(BOOK, { userId: USER_A });
    expect(response.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.storagePath).toMatch(/^pdfs\/[0-9a-f-]{36}\/content\.txt$/);
    expect(body.charCount).toBeGreaterThan(50);

    const { downloadFile } = await import("@/lib/storage");
    const stored = await downloadFile(body.storagePath as string);
    expect(stored.toString("utf-8")).toContain("lamps were lit");
  });

  it("rejects a document with too little extractable text after the PUT", async () => {
    const { response, body } = await uploadBookViaApi("hi", { userId: USER_A });
    expect(response.status).toBe(400);
    expect(body.status === "failed" || body.code === "EXTRACTION_FAILED").toBe(
      true
    );
  });

  it("complete is JSON-only and does not extract while Trigger is configured", async () => {
    process.env.TRIGGER_SECRET_KEY = "tr_test_secret";
    const extract = await import("@/lib/text-extraction");
    const spy = vi.spyOn(extract, "extractTextFromDocument");

    const { POST: presign } = await import("@/app/api/pdf/upload/route");
    const bytes = Buffer.from(BOOK, "utf-8");
    const presignRes = await presign(
      await buildRequest("/api/pdf/upload", {
        userId: USER_A,
        body: {
          fileName: "book.txt",
          contentType: "text/plain",
          byteSize: bytes.length,
        },
      })
    );
    const presignBody = await presignRes.json();
    expect(presignRes.status).toBe(200);

    const { PUT } = await import("@/app/api/pdf/upload/[id]/object/route");
    const putRes = await PUT(
      await buildRequest(presignBody.putUrl, {
        method: "PUT",
        userId: USER_A,
        headers: presignBody.putHeaders,
        rawBody: bytes,
      }),
      routeParams({ id: presignBody.uploadId })
    );
    expect(putRes.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();

    const { POST: complete } = await import(
      "@/app/api/pdf/upload/[id]/route"
    );
    const completeRes = await complete(
      await buildRequest(`/api/pdf/upload/${presignBody.uploadId}`, {
        userId: USER_A,
        body: {},
      }),
      routeParams({ id: presignBody.uploadId })
    );
    const completeBody = await completeRes.json();
    expect(completeRes.status).toBe(200);
    expect(completeBody.status).not.toBe("ready");
    expect(spy).not.toHaveBeenCalled();

    const { extractUploadedDocument } = await import(
      "@/lib/uploads/extract"
    );
    const extracted = await extractUploadedDocument(presignBody.uploadId);
    expect(extracted.status).toBe("ready");
    expect(spy).toHaveBeenCalled();
  });
});
