import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as previewPost } from "@/app/api/tts/preview/route";
import { GET as voicesGet } from "@/app/api/tts/voices/route";
import { edgeTtsProvider } from "@/lib/tts/providers/edge";
import { fishTtsProvider } from "@/lib/tts/providers/fish";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("plays the stored Andrew sample without calling Edge", async () => {
    const response = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: { catalogVoiceId: "standard" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/audio\/mpeg/);
    const audio = Buffer.from(await response.arrayBuffer());
    const recorded = await readFile(
      path.join(process.cwd(), "public", "voice-previews", "standard.mp3")
    );
    expect(audio.equals(recorded)).toBe(true);
    expect(edgeTtsProvider.synthesize).not.toHaveBeenCalled();
    expect(fishTtsProvider.synthesize).not.toHaveBeenCalled();
  });

  it("maps an old Randolph preview onto Andrew's recording", async () => {
    const response = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: { catalogVoiceId: "randolph-expressive" },
      })
    );
    expect(response.status).toBe(200);
    const audio = Buffer.from(await response.arrayBuffer());
    const recorded = await readFile(
      path.join(process.cwd(), "public", "voice-previews", "standard.mp3")
    );
    expect(audio.equals(recorded)).toBe(true);
    expect(edgeTtsProvider.synthesize).not.toHaveBeenCalled();
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
      "ryan",
    ]);
    expect(body.voices.map((voice) => voice.displayName)).toEqual([
      "Andrew",
      "Ava",
      "Libby",
      "Ryan",
    ]);
    for (const voice of body.voices) {
      expect(voice.expressive).toBeUndefined();
      expect(JSON.stringify(voice)).not.toMatch(/expressive/i);
    }
  });
});
