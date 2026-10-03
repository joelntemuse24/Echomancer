import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloneQualityRiskError,
  completeCloneUpload,
  EXTRACT_CONNECTION_LOST_ERROR,
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

  it("hides mammoth's missing-file options error on the upload toast", () => {
    expect(
      networkOrParseError(new Error("Could not find file in options"))
    ).toBe("Couldn't read this Word file. Try PDF or paste.");
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
        const body = JSON.parse(String(init?.body));
        expect(body.byteSize).toBe(4096);
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
        expect((init?.body as Uint8Array).byteLength).toBe(4096);
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
    const result = await uploadBookFile(file, {
      onPhase: (phase) => phases.push(phase),
    });

    expect(result.uploadId).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.status).toBe("extracting");
    expect(result.storagePath).toBe(
      "pdfs/11111111-1111-4111-8111-111111111111/content.txt"
    );
    expect(result.charCount).toBe(0);
    expect(phases).toEqual(["reading", "uploading"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const url = String(input);
        const method = (init?.method || "GET").toUpperCase();
        return url.includes("/api/pdf/upload/11111111") && method === "GET";
      })
    ).toBe(false);
  });

  it("presigns with the sniffed type and real byte size for a Drive-style PDF (no extension, octet-stream)", async () => {
    const pdfBytes = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"
    );
    const file = new File([pdfBytes], "book", {
      type: "application/octet-stream",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url === "/api/pdf/upload" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.contentType).toBe("application/pdf");
        expect(body.byteSize).toBe(pdfBytes.byteLength);
        expect(body.fileName).toBe("book");
        return new Response(
          JSON.stringify({
            uploadId: "22222222-2222-4222-8222-222222222222",
            putUrl: "/api/pdf/upload/22222222-2222-4222-8222-222222222222/object",
            putMethod: "PUT",
            putHeaders: { "Content-Type": "application/pdf" },
            storagePath: "pdfs/22222222-2222-4222-8222-222222222222/content.txt",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/object") && method === "PUT") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          uploadId: "22222222-2222-4222-8222-222222222222",
          status: "extracting",
          storagePath: "pdfs/22222222-2222-4222-8222-222222222222/content.txt",
          fileName: "book",
          charCount: 0,
          fileSize: pdfBytes.byteLength,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadBookFile(file);
    expect(result.format).toBe("pdf");
    expect(result.fileSize).toBe(pdfBytes.byteLength);
  });

  it("reports an unreadable pick instead of failing silently after awaits", async () => {
    const file = new File([new Uint8Array(64)], "drive.pdf", {
      type: "application/pdf",
    });
    (file as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
      () =>
        Promise.reject(
          new DOMException("The file could not be read", "NotReadableError")
        );
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadBookFile(file)).rejects.toThrow(/download it to your device/i);
    // The failure was reported to the server log endpoint.
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/log")).toBe(
      true
    );
    // No presign was ever attempted — the read failed before any other async work.
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => String(init?.body || "").includes("byteSize")
      )
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

  it("rides out dead polls with backoff instead of surfacing Failed to fetch", async () => {
    const ready = (status: string, charCount: number) =>
      new Response(
        JSON.stringify({ status, charCount, storagePath: "pdfs/u1/content.txt" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(ready("extracting", 0))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ready("ready", 900));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const pending = waitForUploadExtract("u1");
    // 1s backoff after the network miss, 2s after the 502, then a normal
    // 1s poll interval, then another 1s backoff before the ready answer.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.status).toBe("ready");
    expect(result.charCount).toBe(900);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it("gives up only after a long outage, with a clear message", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const pending = waitForUploadExtract("u1");
    const assertion = expect(pending).rejects.toThrow(EXTRACT_CONNECTION_LOST_ERROR);
    // Backoff climbs 1s → 2s → 4s → 8s → 10s → 10s → 10s before giving up.
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(8);
    vi.useRealTimers();
  });

  it("does not poll while the tab is hidden and resumes on return", async () => {
    const listeners: Array<() => void> = [];
    const documentStub = {
      hidden: true,
      addEventListener: (_name: string, cb: () => void) => {
        listeners.push(cb);
      },
      removeEventListener: (_name: string, cb: () => void) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const ready = () =>
      new Response(
        JSON.stringify({ status: "ready", charCount: 500 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchMock = vi.fn().mockImplementation(ready);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("window", globalThis);
    vi.useFakeTimers();

    const pending = waitForUploadExtract("u1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();

    documentStub.hidden = false;
    for (const listener of listeners.splice(0)) listener();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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
        expect((init?.body as Uint8Array).byteLength).toBe(file.size);
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

  it("accepts a Drive-style sample with no extension and octet-stream MIME", async () => {
    const wav = new Uint8Array(8192);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set(new TextEncoder().encode("WAVE"), 8);
    const file = new File([wav], "recording", {
      type: "application/octet-stream",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url === "/api/tts/clones/upload" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.contentType).toBe("audio/wav");
        expect(body.byteSize).toBe(wav.byteLength);
        return new Response(
          JSON.stringify({
            uploadId: "clone-upload-2",
            putUrl: "/api/tts/clones/upload/clone-upload-2/object",
            putMethod: "PUT",
            putHeaders: { "Content-Type": "audio/wav" },
            sampleStoragePath: "clones/clone-upload-2/sample.wav",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/object") && method === "PUT") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          clone: { catalogVoiceId: "clone:clone-upload-2", displayName: "Me" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadCloneVoice(file, { title: "Me" });
    expect(result.catalogVoiceId).toBe("clone:clone-upload-2");
  });

  it("rejects bytes that are neither audio nor video before presign", async () => {
    const file = new File([new Uint8Array(8192)], "blob.bin", {
      type: "application/octet-stream",
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadCloneVoice(file)).rejects.toThrow(/audio or video file/i);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input) === "/api/tts/clones/upload")
    ).toBe(false);
  });
});

describe("clone reference gate (client)", () => {
  it("turns a 409 SAMPLE_RISKY into CloneQualityRiskError with the upload id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "This clip may not clone well.",
            code: "SAMPLE_RISKY",
            uploadId: "up1",
            quality: {
              verdict: "fail",
              headline: "This clip may not clone well.",
              body: "Try a cleaner clip.",
              issues: [{ code: "two_speakers", detail: "We hear more than one voice." }],
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } }
        )
      )
    );
    const err = await completeCloneUpload("up1", { title: "Me" }).catch((e) => e);
    expect(err).toBeInstanceOf(CloneQualityRiskError);
    expect(err.uploadId).toBe("up1");
    expect(err.risk.issues[0].code).toBe("two_speakers");
    expect(err.risk.body).toMatch(/cleaner clip/);
  });

  it("sends acceptQualityRisk on Continue anyway", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ clone: { catalogVoiceId: "clone:up1", displayName: "Me" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const clone = await completeCloneUpload("up1", { title: "Me", accent: "irish" }, { acceptQualityRisk: true });
    expect(clone.catalogVoiceId).toBe("clone:up1");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ uploadId: "up1", acceptQualityRisk: true, accent: "irish" });
  });

  it("keeps other 409s as plain errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Busy", code: "OTHER" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const err = await completeCloneUpload("up1").catch((e) => e);
    expect(err).not.toBeInstanceOf(CloneQualityRiskError);
    expect(err.message).toContain("Busy");
  });
});
