import { describe, expect, it, vi } from "vitest";
import { QWEN_SAMPLE_RATE, toPcm16 } from "@/lib/tts/qwen-join";
import { getTtsProvider, isStockProvider, resolveStockAdapter } from "./index";
import {
  QwenTtsError,
  buildQwenSynthBody,
  candidateSeed,
  clampSeed,
  createQwenVoice,
  httpsAudioUrl,
  qwenBaseUrl,
  qwenSynthesizeOnce,
  qwenSynthesizeWithRetry,
  redactSecret,
  renderQwenText,
  sanitizeQwenPrefix,
  type QwenConfig,
  type QwenSynthFn,
} from "./qwen";

const KEY = "sk-test-0123456789abcdef";
const config: QwenConfig = { apiKey: KEY, baseUrl: "https://ws.example/api/v1", model: "qwen-audio-3.1-tts-flash" };

function tone(seconds: number, amp = 0.3): Buffer {
  const n = Math.round(seconds * QWEN_SAMPLE_RATE);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * 180 * i) / QWEN_SAMPLE_RATE);
  return toPcm16(x);
}

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const synthOk = (url = "http://oss.example/a.mp3?Signature=abc") =>
  new Response(JSON.stringify({ request_id: "r1", usage: { characters: 12 }, output: { audio: { url } } }), {
    status: 200,
  });
const audioOk = () => new Response(new Uint8Array(tone(0.2)), { status: 200 });

describe("config and helpers", () => {
  it("builds the Singapore base from the workspace id", () => {
    expect(qwenBaseUrl({ DASHSCOPE_WORKSPACE_ID: "ws1" } as NodeJS.ProcessEnv)).toBe(
      "https://ws1.ap-southeast-1.maas.aliyuncs.com/api/v1"
    );
    expect(qwenBaseUrl({ DASHSCOPE_BASE_URL: "https://x/api/v1/" } as NodeJS.ProcessEnv)).toBe("https://x/api/v1");
  });

  it("switches audio links to https", () => {
    expect(httpsAudioUrl("http://a/b.mp3")).toBe("https://a/b.mp3");
    expect(httpsAudioUrl("https://a/b.mp3")).toBe("https://a/b.mp3");
  });

  it("redacts the key and any bearer token", () => {
    expect(redactSecret(`bad key ${KEY}; Authorization: Bearer abc.def`, KEY)).toBe(
      "bad key <key>; Authorization: Bearer <key>"
    );
  });

  it("clamps seeds and spreads candidate seeds", () => {
    expect(clampSeed(undefined)).toBe(42);
    expect(clampSeed(70000)).toBe(70000 - 65536);
    expect(candidateSeed(42, 0)).toBe(42);
    expect(candidateSeed(42, 1)).not.toBe(42);
  });

  it("sends the seed and omits instruction unless set", () => {
    const body = buildQwenSynthBody({ text: "Hi.", voice: "v1", seed: 7 }, config.model) as {
      model: string;
      input: Record<string, unknown>;
    };
    expect(body.model).toBe("qwen-audio-3.1-tts-flash");
    expect(body.input).toMatchObject({ text: "Hi.", voice: "v1", seed: 7, format: "mp3", sample_rate: 24000 });
    expect(body.input).not.toHaveProperty("instruction");
  });
});

describe("qwenSynthesizeOnce", () => {
  it("posts with the bearer key, then downloads the audio over https", async () => {
    const { impl, calls } = fakeFetch([synthOk(), audioOk()]);
    const out = await qwenSynthesizeOnce({ text: "Hello.", voice: "v1", seed: 9 }, { config, fetchImpl: impl });
    expect(calls[0]!.url).toBe("https://ws.example/api/v1/services/audio/tts/SpeechSynthesizer");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0]!.init!.body)).input.seed).toBe(9);
    expect(calls[1]!.url.startsWith("https://oss.example/")).toBe(true);
    expect(out.audioHost).toBe("oss.example");
    expect(out.requestId).toBe("r1");
    expect(out.audio.length).toBeGreaterThan(1000);
  });

  it("marks 429 and 5xx retryable, 4xx not, and never echoes the key", async () => {
    const e429 = await qwenSynthesizeOnce(
      { text: "x", voice: "v" },
      { config, fetchImpl: fakeFetch([new Response(`limited ${KEY}`, { status: 429, headers: { "retry-after": "2" } })]).impl }
    ).catch((e) => e as QwenTtsError);
    expect(e429).toBeInstanceOf(QwenTtsError);
    expect(e429.retryable).toBe(true);
    expect(e429.retryAfterMs).toBe(2000);
    expect(e429.message).not.toContain(KEY);

    const e400 = await qwenSynthesizeOnce(
      { text: "x", voice: "v" },
      { config, fetchImpl: fakeFetch([new Response("bad voice", { status: 400 })]).impl }
    ).catch((e) => e as QwenTtsError);
    expect(e400.retryable).toBe(false);
  });

  it("fails when the body carries no audio link", async () => {
    const res = new Response(JSON.stringify({ code: "Throttling", message: "slow down" }), { status: 200 });
    await expect(
      qwenSynthesizeOnce({ text: "x", voice: "v" }, { config, fetchImpl: fakeFetch([res]).impl })
    ).rejects.toThrow(/no audio.*Throttling/);
  });
});

describe("qwenSynthesizeWithRetry", () => {
  const ok = { audio: tone(0.2), requestId: "r", usage: null, audioHost: "h", latencyMs: 1 };

  it("retries a retryable failure and then succeeds", async () => {
    const synth = vi
      .fn<QwenSynthFn>()
      .mockRejectedValueOnce(new QwenTtsError("503", { status: 503, retryable: true }))
      .mockResolvedValueOnce(ok);
    const out = await qwenSynthesizeWithRetry({ text: "x", voice: "v" }, { synth, backoffMs: 1 });
    expect(out.attempts).toBe(2);
  });

  it("does not retry a 4xx", async () => {
    const synth = vi.fn<QwenSynthFn>().mockRejectedValue(new QwenTtsError("400", { status: 400, retryable: false }));
    await expect(qwenSynthesizeWithRetry({ text: "x", voice: "v" }, { synth, backoffMs: 1 })).rejects.toThrow("400");
    expect(synth).toHaveBeenCalledTimes(1);
  });

  it("treats silent audio as a retryable failure", async () => {
    const synth = vi
      .fn<QwenSynthFn>()
      .mockResolvedValueOnce({ ...ok, audio: Buffer.alloc(4000) })
      .mockResolvedValueOnce(ok);
    const out = await qwenSynthesizeWithRetry({ text: "x", voice: "v" }, { synth, backoffMs: 1 });
    expect(out.attempts).toBe(2);
  });
});

describe("renderQwenText", () => {
  it("synthesizes each chunk with the seed, in order, and joins them", async () => {
    const seen: { text: string; seed?: number }[] = [];
    const synth: QwenSynthFn = async (req) => {
      seen.push({ text: req.text, seed: req.seed });
      return { audio: tone(0.5), requestId: null, usage: null, audioHost: null, latencyMs: 0 };
    };
    const text = Array.from({ length: 8 }, (_, i) => `This is sentence ${i} of a long paragraph about rivers.`).join(" ");
    const out = await renderQwenText(text, {
      voice: "v1",
      seed: 5,
      synth,
      decode: async (b) => b,
      encode: false,
      post: { deline: false, degate: true },
    });
    expect(out.takes.length).toBeGreaterThan(1);
    expect(seen.every((s) => s.seed === 5)).toBe(true);
    expect(out.takes.map((t) => t.chunk.index)).toEqual(out.takes.map((_, i) => i));
    expect(out.durationHintSeconds).toBeGreaterThan(out.takes.length * 0.5);
  });

  it("keeps the best-scoring candidate when asked for several", async () => {
    let n = 0;
    const synth: QwenSynthFn = async () => {
      n++;
      return { audio: tone(0.3, 0.1 * n), requestId: null, usage: null, audioHost: null, latencyMs: 0 };
    };
    // Sample 33 sits near the sine peak, so louder candidates score lower.
    const scorer = vi.fn(async (audio: Buffer) => -audio.readInt16LE(66));
    const out = await renderQwenText("One short sentence for the test.", {
      voice: "v1",
      seed: 1,
      candidates: 3,
      scorer,
      synth,
      decode: async (b) => b,
      encode: false,
      post: { deline: false, degate: false },
    });
    expect(out.takes[0]!.candidates).toHaveLength(3);
    expect(out.takes[0]!.seed).toBe(out.takes[0]!.candidates[2]!.seed);
  });
});

describe("createQwenVoice", () => {
  it("sends a create_voice body with a clean prefix and returns the voice id", async () => {
    const { impl, calls } = fakeFetch([
      new Response(JSON.stringify({ output: { voice_id: "qwen-tts-vc-abc" } }), { status: 200 }),
    ]);
    const id = await createQwenVoice(
      { audio: Buffer.from("RIFFxxxx"), prefix: "My Narrator 01!" },
      { config, fetchImpl: impl }
    );
    expect(id).toBe("qwen-tts-vc-abc");
    expect(calls[0]!.url).toBe("https://ws.example/api/v1/services/audio/tts/customization");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.model).toBe("voice-enrollment");
    expect(body.input).toMatchObject({
      action: "create_voice",
      target_model: "qwen-audio-3.1-tts-flash",
      prefix: "mynarrato",
      max_prompt_audio_length: 6,
      enable_preprocess: false,
    });
    expect(body.input.audio.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  it("sanitizes prefixes", () => {
    expect(sanitizeQwenPrefix("!!")).toBe("echo");
  });
});

describe("provider registry", () => {
  it("resolves qwen", () => {
    expect(isStockProvider("qwen")).toBe(true);
    expect(getTtsProvider("qwen").id).toBe("qwen");
    expect(resolveStockAdapter({ provider: "qwen", model: "qwen-audio-3.1-tts-flash" }).id).toBe("qwen");
  });
});
