import { afterEach, describe, expect, it, vi } from "vitest";
import { FISH_LONG_PAUSE, FISH_SHORT_PAUSE } from "@/lib/tts/narration-script";
import { SSML_LONG_BREAK, SSML_SHORT_BREAK } from "@/lib/tts/ssml-pauses";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GOOGLE_TTS_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_TTS_ACCESS_TOKEN;
});

describe("googleTtsProvider", () => {
  it("sends SSML breaks for Fish pause tags and keeps speakingRate", async () => {
    process.env.GOOGLE_TTS_API_KEY = "test-google-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ audioContent: Buffer.from("ID3g").toString("base64") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { googleTtsProvider } = await import("./google");
    await googleTtsProvider.synthesize({
      text: `Hello ${FISH_SHORT_PAUSE} world\n${FISH_LONG_PAUSE}\nTom & Jerry`,
      voiceId: "en-GB-Neural2-O",
      speed: 0.85,
    });

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      input?: { text?: string; ssml?: string };
      audioConfig?: { speakingRate?: number };
    };
    expect(body.input?.text).toBeUndefined();
    expect(body.input?.ssml).toContain("<speak>");
    expect(body.input?.ssml).toContain(SSML_SHORT_BREAK);
    expect(body.input?.ssml).toContain(SSML_LONG_BREAK);
    expect(body.input?.ssml).toContain("Tom &amp; Jerry");
    expect(body.input?.ssml).not.toMatch(/\[(?:long-)?break\]/i);
    expect(body.audioConfig?.speakingRate).toBe(0.85);
  });

  it("keeps plain text input when there are no pause tags", async () => {
    process.env.GOOGLE_TTS_API_KEY = "test-google-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ audioContent: Buffer.from("ID3g").toString("base64") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { googleTtsProvider } = await import("./google");
    await googleTtsProvider.synthesize({
      text: "Hello from Randolph.",
      voiceId: "en-GB-Neural2-O",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      input?: { text?: string; ssml?: string };
    };
    expect(body.input?.ssml).toBeUndefined();
    expect(body.input?.text).toBe("Hello from Randolph.");
  });
});
