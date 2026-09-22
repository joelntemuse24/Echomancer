import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NETWORK_UPLOAD_ERROR,
  PAYLOAD_TOO_LARGE_ERROR,
  networkOrParseError,
  readErrorMessage,
  uploadBookFile,
  uploadCloneVoice,
  uploadIdFromStoragePath,
  waitForUploadExtract,
} from "@/lib/upload-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("upload client errors", () => {
  it("surfaces JSON error bodies", async () => {
    const res = new Response(JSON.stringify({ error: "File too large. Maximum size is 512MB." }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
    expect(await readErrorMessage(res)).toContain("512MB");
  });

  it("surfaces clone-sample quality fail copy from the structured body", async () => {
    const res = new Response(
      JSON.stringify({
        error: "This sample isn't good enough to clone well.",
        code: "SAMPLE_QUALITY",
        ok: false,
        verdict: "fail",
        headline: "This sample isn't good enough to clone well.",
        primary_message:
          "Please re-record a fresh sample (don't try to 'fix' this one with cleaners).",
      }),
      { status: 422, headers: { "content-type": "application/json" } }
    );
    const message = await readErrorMessage(res);
    expect(message).toContain("isn't good enough to clone well");
    expect(message).toContain("re-record a fresh sample");
  });

  it("does not show Failed to fetch / plaintext 413 as a parse crash", async () => {
    const res = new Response("FUNCTION_PAYLOAD_TOO_LARGE", { status: 413 });
    expect(await readErrorMessage(res)).toBe(PAYLOAD_TOO_LARGE_ERROR);
  });

  it("maps TypeError Failed to fetch to a storage/network message", () => {
    expect(networkOrParseError(new TypeError("Failed to fetch"))).toBe(
      NETWORK_UPLOAD_ERROR
    );
  });
});

describe("uploadIdFromStoragePath", () => {
  it("reads the upload id from a document storage path", () => {
    expect(
      uploadIdFromStoragePath("pdfs/11111111-1111-4111-8111-111111111111/content.txt")
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(uploadIdFromStoragePath("audiobooks/job/full.mp3")).toBeNull();
  });
});

describe("uploadBookFile", () => {
  it("returns after complete even while extract is still running", async () => {
    const file = new File([new Uint8Array(4096)], "book.txt", {
      type: "text/plain",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url === "/api/pdf/upload" && method === "POST") {
        return new Response(
          JSON.stringify({
            uploadId: "11111111-1111-4111-8111-111111111111",
            putUrl: "/api/pdf/upload/11111111-1111-4111-8111-111111111111/object",
            putMethod: "PUT",
            putHeaders: { "Content-Type": "text/plain" },
            storagePath: "pdfs/11111111-1111-4111-8111-111111111111/content.txt",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/object") && method === "PUT") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (
        url === "/api/pdf/upload/11111111-1111-4111-8111-111111111111" &&
        method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            uploadId: "11111111-1111-4111-8111-111111111111",
            status: "extracting",
            storagePath: "pdfs/11111111-1111-4111-8111-111111111111/content.txt",
            fileName: "book.txt",
            charCount: 0,
            fileSize: file.size,
            format: "txt",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const phases: string[] = [];
    const result = await uploadBookFile(file, (phase) => phases.push(phase));

    expect(result.uploadId).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.status).toBe("extracting");
    expect(result.storagePath).toBe(
      "pdfs/11111111-1111-4111-8111-111111111111/content.txt"
    );
    expect(result.charCount).toBe(0);
    expect(phases).toEqual(["uploading"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const url = String(input);
        const method = (init?.method || "GET").toUpperCase();
        return url.includes("/api/pdf/upload/11111111") && method === "GET";
      })
    ).toBe(false);
  });
});

describe("waitForUploadExtract", () => {
  it("polls until ready and surfaces extract failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: "u1",
            status: "extracting",
            storagePath: "pdfs/u1/content.txt",
            charCount: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploadId: "u1",
            status: "ready",
            storagePath: "pdfs/u1/content.txt",
            charCount: 1200,
            fileName: "book.txt",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const pending = waitForUploadExtract("u1");
    await vi.advanceTimersByTimeAsync(1000);
    const ready = await pending;

    expect(ready.status).toBe("ready");
    expect(ready.charCount).toBe(1200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "failed",
          error: "Could not extract enough text from this document.",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    await expect(waitForUploadExtract("u1")).rejects.toThrow(/extract enough text/i);
    vi.useRealTimers();
  });
});

describe("uploadCloneVoice", () => {
  it("presigns, PUTs the sample to storage, then completes with JSON", async () => {
    const file = new File([new Uint8Array(8192)], "alex.mp3", {
      type: "audio/mpeg",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url === "/api/tts/clones/upload" && method === "POST") {
        expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
        const body = JSON.parse(String(init?.body));
        expect(body.fileName).toBe("alex.mp3");
        expect(body.byteSize).toBe(file.size);
        return new Response(
          JSON.stringify({
            uploadId: "clone-upload-1",
            putUrl: "/api/tts/clones/upload/clone-upload-1/object",
            putMethod: "PUT",
            putHeaders: { "Content-Type": "audio/mpeg", "Content-Length": "8192" },
            sampleStoragePath: "clones/clone-upload-1/sample.mp3",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/object") && method === "PUT") {
        expect(init?.body).toBe(file);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "/api/tts/clones" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.uploadId).toBe("clone-upload-1");
        expect(body.title).toBe("Alex");
        expect(body.accent).toBe("british");
        expect(String(init?.body)).not.toContain("audio");
        return new Response(
          JSON.stringify({
            clone: {
              catalogVoiceId: "clone:clone-upload-1",
              displayName: "Alex",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadCloneVoice(file, {
      title: "Alex",
      accent: "british",
    });
    expect(result.catalogVoiceId).toBe("clone:clone-upload-1");
    expect(result.displayName).toBe("Alex");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
