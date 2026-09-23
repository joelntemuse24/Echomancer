import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewPost } from "@/app/api/tts/preview/route";
import { GET as voicesGet } from "@/app/api/tts/voices/route";
import { edgeTtsProvider } from "@/lib/tts/providers/edge";
import { fishTtsProvider } from "@/lib/tts/providers/fish";
import { googleTtsProvider } from "@/lib/tts/providers/google";
import {
  FISH_TWIN_GATE_ENV,
  FISH_TWIN_REF_ENV,
} from "@/lib/tts/fish-stock-twins";
import { FISH_COMPARE_SCRIPT } from "@/lib/tts/delivery-sample";
import { expressivePreviewCacheKey } from "@/lib/tts/expressive-preview-cache";
import { FISH_TWIN_MODEL } from "@/lib/tts/fish-stock-twins";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { uploadFile } from "@/lib/storage";
import {
  USER_A,
  buildRequest,
  emptyWav,
  fakeMp3,
  resetDatabase,
} from "@/test/harness";

const SAMPLE_REF = "a50f1ee074124ba2b1dc44623f99abbe";

function clearTwinEnv() {
  for (const key of Object.values(FISH_TWIN_GATE_ENV)) delete process.env[key];
  for (const key of Object.values(FISH_TWIN_REF_ENV)) delete process.env[key];
}

describe("Standard vs Expressive preview", () => {
  beforeEach(async () => {
    clearTwinEnv();
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
    clearTwinEnv();
    vi.restoreAllMocks();
  });

  it("plays the compare line on Edge and on Fish without an upload", async () => {
    process.env.FISH_TWIN_STANDARD = "1";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;

    const standard = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: {
          catalogVoiceId: "standard",
          delivery: "standard",
          sample: "compare",
        },
      })
    );
    expect(standard.status).toBe(200);
    expect(standard.headers.get("content-type")).toMatch(/audio/i);
    const edgeCall = vi.mocked(edgeTtsProvider.synthesize).mock.calls[0]?.[0];
    expect(edgeCall?.voiceId).toBe("en-US-AndrewNeural");
    expect(edgeCall?.text).toContain("We leave at dawn");
    expect(edgeCall?.text).not.toContain("[soft tone]");
    expect(edgeCall?.text).not.toContain("[emphasis]");

    const expressive = await previewPost(
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
    expect(expressive.status).toBe(200);
    const fishCall = vi.mocked(fishTtsProvider.synthesize).mock.calls[0]?.[0];
    expect(fishCall?.voiceId).toBe(SAMPLE_REF);
    expect(fishCall?.catalogVoiceId).toBe("standard");
    expect(fishCall?.model).toBe("s2.1-pro-free");
    expect(fishCall?.text).toBe(FISH_COMPARE_SCRIPT);
    expect(fishCall?.text).not.toContain("[emphasis]");
    expect(fishCall?.text).not.toContain("[long-break]");
    expect(fishCall?.text).toContain("We leave at dawn");
    expect(expressive.headers.get("x-preview-cache")).toBe("miss");
    expect(expressive.headers.get("cache-control")).toContain("no-store");
  });

  it("replays a saved Expressive compare clip for each twin without calling Fish", async () => {
    const slots = [
      {
        id: "standard",
        gate: "FISH_TWIN_STANDARD",
        refEnv: "FISH_TWIN_STANDARD_REF",
        ref: SAMPLE_REF,
      },
      {
        id: "michelle",
        gate: "FISH_TWIN_MICHELLE",
        refEnv: "FISH_TWIN_MICHELLE_REF",
        ref: "b50f1ee074124ba2b1dc44623f99abbe",
      },
      {
        id: "randolph",
        gate: "FISH_TWIN_RANDOLPH",
        refEnv: "FISH_TWIN_RANDOLPH_REF",
        ref: "c50f1ee074124ba2b1dc44623f99abbe",
      },
    ] as const;
    for (const slot of slots) {
      process.env[slot.gate] = "1";
      process.env[slot.refEnv] = slot.ref;
    }

    let seed = 0;
    vi.mocked(fishTtsProvider.synthesize).mockImplementation(async () => {
      seed += 1;
      return { audio: fakeMp3(2048, seed), contentType: "audio/mpeg" };
    });

    const play = async (catalogVoiceId: string) =>
      previewPost(
        await buildRequest("/api/tts/preview", {
          method: "POST",
          userId: USER_A,
          body: {
            catalogVoiceId,
            delivery: "expressive",
            sample: "compare",
          },
        })
      );

    for (const slot of slots) {
      const before = vi.mocked(fishTtsProvider.synthesize).mock.calls.length;
      const first = await play(slot.id);
      expect(first.status).toBe(200);
      expect(first.headers.get("x-preview-cache")).toBe("miss");
      const firstBytes = Buffer.from(await first.arrayBuffer());
      const call = vi.mocked(fishTtsProvider.synthesize).mock.calls.at(-1)?.[0];
      expect(call?.text).toBe(FISH_COMPARE_SCRIPT);
      expect(call?.voiceId).toBe(slot.ref);
      expect(call?.model).toBe("s2.1-pro-free");

      const second = await play(slot.id);
      expect(second.status).toBe(200);
      expect(second.headers.get("x-preview-cache")).toBe("hit");
      expect(vi.mocked(fishTtsProvider.synthesize).mock.calls.length).toBe(
        before + 1
      );
      expect(Buffer.from(await second.arrayBuffer()).equals(firstBytes)).toBe(
        true
      );
    }

    process.env.FISH_TWIN_STANDARD_REF = "d50f1ee074124ba2b1dc44623f99abbe";
    const beforeRef = vi.mocked(fishTtsProvider.synthesize).mock.calls.length;
    const regenerated = await play("standard");
    expect(regenerated.headers.get("x-preview-cache")).toBe("miss");
    expect(vi.mocked(fishTtsProvider.synthesize).mock.calls.length).toBe(
      beforeRef + 1
    );
    expect(
      vi.mocked(fishTtsProvider.synthesize).mock.calls.at(-1)?.[0]?.voiceId
    ).toBe("d50f1ee074124ba2b1dc44623f99abbe");
  });

  it("regenerates a silent saved clip and still synthesizes Standard each time", async () => {
    process.env.FISH_TWIN_STANDARD = "1";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;
    const key = expressivePreviewCacheKey({
      catalogVoiceId: "standard",
      referenceId: SAMPLE_REF,
      model: FISH_TWIN_MODEL,
      script: FISH_COMPARE_SCRIPT,
    });
    await uploadFile(
      "previews/expressive",
      `${key}.mp3`,
      emptyWav(),
      "audio/mpeg"
    );

    const expressive = await previewPost(
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
    expect(expressive.status).toBe(200);
    expect(expressive.headers.get("x-preview-cache")).toBe("miss");
    expect(vi.mocked(fishTtsProvider.synthesize)).toHaveBeenCalledTimes(1);

    const edgeBefore = vi.mocked(edgeTtsProvider.synthesize).mock.calls.length;
    for (let i = 0; i < 2; i++) {
      const standard = await previewPost(
        await buildRequest("/api/tts/preview", {
          method: "POST",
          userId: USER_A,
          body: {
            catalogVoiceId: "standard",
            delivery: "standard",
            sample: "compare",
          },
        })
      );
      expect(standard.status).toBe(200);
      expect(standard.headers.get("x-preview-cache")).toBeNull();
    }
    expect(vi.mocked(edgeTtsProvider.synthesize).mock.calls.length).toBe(
      edgeBefore + 2
    );
    expect(vi.mocked(fishTtsProvider.synthesize)).toHaveBeenCalledTimes(1);
  });

  it("keeps the short row preview on the baseline voice", async () => {
    process.env.FISH_TWIN_STANDARD = "1";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;
    const response = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: { catalogVoiceId: "standard" },
      })
    );
    expect(response.status).toBe(200);
    const call = vi.mocked(edgeTtsProvider.synthesize).mock.calls[0]?.[0];
    expect(call?.text).toBe(PREVIEW_TEXT);
    expect(call?.voiceId).toBe("en-US-AndrewNeural");
    expect(vi.mocked(fishTtsProvider.synthesize)).not.toHaveBeenCalled();
  });

  it("refuses Expressive preview when the gate is closed", async () => {
    process.env.FISH_TWIN_RANDOLPH_REF = SAMPLE_REF;
    const response = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: {
          catalogVoiceId: "randolph",
          delivery: "expressive",
          sample: "compare",
        },
      })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("EXPRESSIVE_UNAVAILABLE");
    expect(vi.mocked(googleTtsProvider.synthesize)).not.toHaveBeenCalled();
    expect(vi.mocked(fishTtsProvider.synthesize)).not.toHaveBeenCalled();
  });

  it("refuses Expressive for Clara", async () => {
    const response = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: { catalogVoiceId: "clara", delivery: "expressive" },
      })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("EXPRESSIVE_NOT_OFFERED");
  });
});

describe("voices catalog expressive offer", () => {
  beforeEach(async () => {
    clearTwinEnv();
    await resetDatabase();
  });

  afterEach(() => {
    clearTwinEnv();
  });

  it("reports availability without a Fish reference id", async () => {
    process.env.FISH_TWIN_STANDARD = "1";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;
    process.env.FISH_TWIN_MICHELLE_REF = SAMPLE_REF;

    const response = await voicesGet(
      await buildRequest("/api/tts/voices", { userId: USER_A, method: "GET" })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      voices: Array<{
        id: string;
        provider: string;
        providerVoiceId: string;
        expressive: { configured: boolean; available: boolean } | null;
      }>;
    };
    const standard = body.voices.find((voice) => voice.id === "standard");
    const michelle = body.voices.find((voice) => voice.id === "michelle");
    const clara = body.voices.find((voice) => voice.id === "clara");
    const randolph = body.voices.find((voice) => voice.id === "randolph");
    expect(standard).toMatchObject({
      provider: "edge",
      providerVoiceId: "en-US-AndrewNeural",
      expressive: { configured: true, available: true },
    });
    expect(michelle).toMatchObject({
      provider: "edge",
      expressive: { configured: true, available: false },
    });
    expect(randolph?.expressive).toEqual({
      configured: false,
      available: false,
    });
    expect(clara?.expressive).toBeNull();
    expect(clara?.provider).toBe("fish");
    expect(JSON.stringify(standard?.expressive)).not.toContain(SAMPLE_REF);
    expect(JSON.stringify(michelle?.expressive)).not.toContain(SAMPLE_REF);
  });
});
