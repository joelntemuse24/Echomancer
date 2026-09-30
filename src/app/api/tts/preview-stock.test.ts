import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewPost } from "@/app/api/tts/preview/route";
import { GET as voicesGet } from "@/app/api/tts/voices/route";
import { edgeTtsProvider } from "@/lib/tts/providers/edge";
import { fishTtsProvider } from "@/lib/tts/providers/fish";
import { googleTtsProvider } from "@/lib/tts/providers/google";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { USER_A, buildRequest, fakeMp3, resetDatabase } from "@/test/harness";

describe("stock preview", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.spyOn(edgeTtsProvider, "synthesize").mockResolvedValue({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    });
    vi.spyOn(fishTtsProvider, "synthesize").mockResolvedValue({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    });
    vi.spyOn(googleTtsProvider, "synthesize").mockResolvedValue({
      audio: fakeMp3(),
      contentType: "audio/mpeg",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("previews Andrew on Edge with the short sample", async () => {
    const response = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: { catalogVoiceId: "standard" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/audio/i);
    const call = vi.mocked(edgeTtsProvider.synthesize).mock.calls[0]?.[0];
    expect(call?.voiceId).toBe("en-US-AndrewNeural");
    expect(call?.text).toBe(PREVIEW_TEXT);
    expect(fishTtsProvider.synthesize).not.toHaveBeenCalled();
  });

  it("maps an Expressive preview request onto the plain voice", async () => {
    const andrew = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: {
          catalogVoiceId: "standard",
          delivery: "expressive",
          sample: "compare",
        },
      })
    );
    expect(andrew.status).toBe(200);
    expect(vi.mocked(edgeTtsProvider.synthesize).mock.calls[0]?.[0]?.voiceId).toBe(
      "en-US-AndrewNeural"
    );
    expect(fishTtsProvider.synthesize).not.toHaveBeenCalled();

    const randolph = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: { catalogVoiceId: "randolph-expressive" },
      })
    );
    expect(randolph.status).toBe(200);
    expect(vi.mocked(googleTtsProvider.synthesize).mock.calls[0]?.[0]?.voiceId).toBe(
      "en-GB-Neural2-O"
    );
  });
});

describe("voices catalog", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists each stock voice once and omits an expressive offer", async () => {
    const response = await voicesGet(
      await buildRequest("/api/tts/voices", { userId: USER_A })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      voices: { id: string; displayName: string; expressive?: unknown }[];
    };
    expect(body.voices.map((voice) => voice.id)).toEqual([
      "standard",
      "ava",
      "libby",
      "randolph",
    ]);
    expect(body.voices.map((voice) => voice.displayName)).toEqual([
      "Andrew",
      "Ava",
      "Libby",
      "Randolph",
    ]);
    for (const voice of body.voices) {
      expect(voice.expressive).toBeUndefined();
      expect(JSON.stringify(voice)).not.toMatch(/expressive/i);
    }
  });
});
