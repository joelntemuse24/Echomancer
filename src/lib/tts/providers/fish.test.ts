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
