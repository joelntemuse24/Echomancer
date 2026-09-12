import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NETWORK_UPLOAD_ERROR,
  PAYLOAD_TOO_LARGE_ERROR,
  networkOrParseError,
  readErrorMessage,
  uploadCloneVoice,
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

    const result = await uploadCloneVoice(file, { title: "Alex" });
    expect(result.catalogVoiceId).toBe("clone:clone-upload-1");
    expect(result.displayName).toBe("Alex");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
