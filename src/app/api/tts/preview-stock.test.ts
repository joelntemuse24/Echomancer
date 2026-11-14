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

  it("does not serve Andrew's file for the retired id: a pick lands on Drew", async () => {
    // Andrew is retired. A stale pick or old client that still says `standard`
    // is coerced to Drew and served Drew's committed sample — an Andrew
    // recording is not substituted for the new narrator.
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
      path.join(process.cwd(), "public", "voice-previews", "drew.mp3")
    );
    expect(audio.equals(recorded)).toBe(true);
    expect(edgeTtsProvider.synthesize).not.toHaveBeenCalled();
    expect(fishTtsProvider.synthesize).not.toHaveBeenCalled();
  });

  it("serves the committed Echomancer Andrew sample", async () => {
    const response = await previewPost(
      await buildRequest("/api/tts/preview", {
        method: "POST",
        userId: USER_A,
        body: { catalogVoiceId: "echomancer-andrew" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/audio\/mpeg/);
    const audio = Buffer.from(await response.arrayBuffer());
    const recorded = await readFile(
      path.join(
        process.cwd(),
        "public",
        "voice-previews",
        "echomancer-andrew.mp3"
      )
    );
    expect(audio.equals(recorded)).toBe(true);
  });

  it("maps an old Randolph preview onto Drew, not Andrew", async () => {
    // Randolph left the pile for Andrew, and Andrew has now left for Drew, so
    // the two aliases compose and the committed Drew sample is served.
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
      path.join(process.cwd(), "public", "voice-previews", "drew.mp3")
    );
    expect(audio.equals(recorded)).toBe(true);
    expect(edgeTtsProvider.synthesize).not.toHaveBeenCalled();
  });
});

describe("voices catalog", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.DREW_ENABLED = "1";
    process.env.DREW_URL = "https://example.modal.run";
    process.env.DREW_TOKEN = "token";
  });

  afterEach(() => {
    delete process.env.DREW_ENABLED;
    delete process.env.DREW_URL;
    delete process.env.DREW_TOKEN;
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
      "drew",
      "echomancer-andrew",
      "ava",
      "libby",
    ]);
    expect(body.voices.map((voice) => voice.displayName)).toEqual([
      "Drew",
      "Echomancer Andrew",
      "Ava",
      "Libby",
    ]);
    expect(body.voices.map((voice) => voice.id)).not.toContain("standard");
    for (const voice of body.voices) {
      expect(voice.expressive).toBeUndefined();
      expect(JSON.stringify(voice)).not.toMatch(/expressive/i);
    }
  });
});
