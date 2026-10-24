import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paradeeTtsProvider,
  splitParadeeText,
} from "@/lib/tts/providers/paradee";

const ENV_KEYS = [
  "PARADEE_URL",
  "PARADEE_SECRET",
  "WORKER_URL",
  "TAKEHOME_WORKER_URL",
  "WORKER_SECRET",
  "TAKEHOME_WORKER_SECRET",
  "INTERNAL_JOB_SECRET",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "audio/mpeg" },
  });
}

describe("paradeeTtsProvider URL selection", () => {
  it("posts to the local sidecar when PARADEE_URL is set", async () => {
    process.env.PARADEE_URL = "http://127.0.0.1:8791/";
    process.env.PARADEE_SECRET = "sidecar-secret";
    process.env.WORKER_URL = "https://worker.example.com";
    process.env.WORKER_SECRET = "worker-secret";
    const fetchMock = vi.fn(async () => jsonResponse("mp3"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await paradeeTtsProvider.synthesize({
      text: "Hello there.",
      voiceId: "paradee-v1.1-int8",
      speed: 1.25,
    });

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.audio.toString()).toBe("mp3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:8791/synthesize");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sidecar-secret");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Hello there.",
      speed: 1.25,
      format: "mp3",
    });
  });

  it("omits the sidecar auth header when PARADEE_SECRET is unset", async () => {
    process.env.PARADEE_URL = "http://127.0.0.1:8791";
    const fetchMock = vi.fn(async () => jsonResponse("mp3"));
    vi.stubGlobal("fetch", fetchMock);

    await paradeeTtsProvider.synthesize({ text: "Hi.", voiceId: "v" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init.body)).speed).toBe(1);
  });

  it("proxies through the worker with the shared secret on Vercel", async () => {
    process.env.TAKEHOME_WORKER_URL = "https://worker.example.com/";
    process.env.WORKER_URL = "https://fallback.example.com";
    process.env.WORKER_SECRET = "worker-secret";
    const fetchMock = vi.fn(async () => jsonResponse("mp3"));
    vi.stubGlobal("fetch", fetchMock);

    await paradeeTtsProvider.synthesize({ text: "Hello.", voiceId: "v" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://worker.example.com/paradee/synthesize");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer worker-secret"
    );
  });

  it("falls back to WORKER_URL when TAKEHOME_WORKER_URL is unset", async () => {
    process.env.WORKER_URL = "https://worker.example.com";
    process.env.INTERNAL_JOB_SECRET = "internal-secret";
    const fetchMock = vi.fn(async () => jsonResponse("mp3"));
    vi.stubGlobal("fetch", fetchMock);

    await paradeeTtsProvider.synthesize({ text: "Hello.", voiceId: "v" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://worker.example.com/paradee/synthesize");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer internal-secret"
    );
  });

  it("throws with the status and body on a non-2xx response", async () => {
    process.env.PARADEE_URL = "http://127.0.0.1:8791";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse('{"error":"model not loaded"}', 503))
    );

    await expect(
      paradeeTtsProvider.synthesize({ text: "Hello.", voiceId: "v" })
    ).rejects.toThrow(/503.*model not loaded/s);
  });

  it("throws when neither PARADEE_URL nor a worker URL is configured", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      paradeeTtsProvider.synthesize({ text: "Hello.", voiceId: "v" })
    ).rejects.toThrow(/not configured/i);
  });
});

describe("paradee long text", () => {
  it("splits at sentence boundaries into pieces of at most 4000 chars", () => {
    const sentence = `${"a".repeat(1490)}. `;
    const text = sentence.repeat(5).trim();
    expect(text.length).toBeGreaterThan(4000);

    const pieces = splitParadeeText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(4000);
      expect(piece.trimEnd().endsWith(".")).toBe(true);
    }
    expect(pieces.join("")).toBe(text);
  });

  it("concatenates synthesized pieces in order with concurrency 2", async () => {
    const sentence = `${"b".repeat(1490)}. `;
    const text = sentence.repeat(5).trim();
    const pieces = splitParadeeText(text);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = JSON.parse(String(init.body)) as { text: string };
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse(`[${body.text.slice(0, 1)}${body.text.length}]`);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.PARADEE_URL = "http://127.0.0.1:8791";

    const result = await paradeeTtsProvider.synthesize({
      text,
      voiceId: "v",
    });

    expect(fetchMock).toHaveBeenCalledTimes(pieces.length);
    expect(maxInFlight).toBe(2);
    expect(result.audio.toString()).toBe(
      pieces.map((piece) => `[${piece.slice(0, 1)}${piece.length}]`).join("")
    );
  });
});
