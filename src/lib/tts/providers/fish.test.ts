import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FISH_API_KEY;
});

describe("isFishLiveVoice", () => {
  it("is false without FISH_API_KEY", async () => {
    const { isFishLiveVoice } = await import("./fish");
    expect(
      isFishLiveVoice({
        provider: "fish",
        catalogVoiceId: "clone:abc",
        model: "fish-audio/s2.1-pro-free:free",
      })
    ).toBe(false);
  });

  it("matches clones and Fish catalog models when configured", async () => {
    process.env.FISH_API_KEY = "test-key";
    const { isFishLiveVoice } = await import("./fish");
    expect(
      isFishLiveVoice({ provider: "fish", catalogVoiceId: "clone:1" })
    ).toBe(true);
    expect(
      isFishLiveVoice({
        provider: "openrouter",
        model: "fish-audio/s2.1-pro-free:free",
        catalogVoiceId: "fish-narrator",
      })
    ).toBe(true);
    expect(
      isFishLiveVoice({
        provider: "gemini",
        model: "google/gemini-2.5-flash-tts",
        catalogVoiceId: "gemini-kore",
      })
    ).toBe(false);
  });
});

describe("stock Narrator vs clone reference_id", () => {
  it("does not send the OpenRouter catalog UUID as Fish reference_id", async () => {
    process.env.FISH_API_KEY = "test-key";
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fishTtsProvider } = await import("./fish");
    await fishTtsProvider.synthesize({
      text: "Hello",
      voiceId: "00a1b221-6137-4b73-ad62-b0cbce134167",
      catalogVoiceId: "fish-narrator",
      model: "fish-audio/s2.1-pro-free:free",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.reference_id).toBeUndefined();
    expect(body.text).toBe("Hello");
    expect(body.format).toBe("mp3");
  });

  it("still sends a clone's real Fish reference_id", async () => {
    process.env.FISH_API_KEY = "test-key";
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fishTtsProvider } = await import("./fish");
    await fishTtsProvider.synthesize({
      text: "Hello",
      voiceId: "real-fish-account-ref",
      catalogVoiceId: "clone:abc",
      model: "s2.1-pro-free",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
      reference_id: "real-fish-account-ref",
    });
  });
});

describe("streamFishHttp", () => {
  it("yields chunked MP3 bytes from Fish HTTP streaming", async () => {
    process.env.FISH_API_KEY = "test-key";

    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i]!);
          i += 1;
        } else {
          controller.close();
        }
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );

    const { streamFishHttp } = await import("./fish");
    const out: number[] = [];
    for await (const chunk of streamFishHttp({
      text: "Hello",
      voiceId: "voice-1",
      model: "fish-audio/s2.1-pro-free:free",
    })) {
      out.push(...chunk);
    }

    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/tts"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          model: "s2.1-pro-free",
        }),
      })
    );
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      body: string;
    };
    expect(JSON.parse(init.body)).toMatchObject({
      text: "Hello",
      format: "mp3",
      reference_id: "voice-1",
      latency: "balanced",
    });
  });
});

describe("synthesizeFish latency", () => {
  it("uses balanced by default and normal when asked", async () => {
    process.env.FISH_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.latency).toBeDefined();
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fishTtsProvider } = await import("./fish");
    await fishTtsProvider.synthesize({
      text: "Hello",
      voiceId: "voice-1",
      model: "s2.1-pro-free",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
      latency: "balanced",
    });

    await fishTtsProvider.synthesize({
      text: "Hello",
      voiceId: "voice-1",
      model: "s2.1-pro-free",
      latency: "normal",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toMatchObject({
      latency: "normal",
    });
  });

  it("sends chunk_length when asked and omits default speed", async () => {
    process.env.FISH_API_KEY = "test-key";
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fishTtsProvider } = await import("./fish");
    await fishTtsProvider.synthesize({
      text: "Hello",
      voiceId: "voice-1",
      model: "s2.1-pro-free",
      latency: "normal",
      chunkLength: 300,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
      latency: "normal",
      chunk_length: 300,
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).prosody
    ).toBeUndefined();
  });

  it("honors Retry-After on 429", async () => {
    process.env.FISH_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "2" },
        })
      )
    );

    const { fishTtsProvider, FishRateLimitError } = await import("./fish");
    await expect(
      fishTtsProvider.synthesize({ text: "Hi", voiceId: "v", model: "s2.1-pro-free" })
    ).rejects.toBeInstanceOf(FishRateLimitError);
    try {
      await fishTtsProvider.synthesize({
        text: "Hi",
        voiceId: "v",
        model: "s2.1-pro-free",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(FishRateLimitError);
      expect((err as InstanceType<typeof FishRateLimitError>).retryAfterMs).toBe(
        2000
      );
    }
  });
});
