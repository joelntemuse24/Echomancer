import { beforeEach, describe, expect, it, vi } from "vitest";
import { pcmToWav } from "@/lib/tts/pcm-wav";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";
import { uploadFile } from "@/lib/storage";
import { insertPendingCloneUpload } from "@/lib/turso/clone-uploads";
import { queryOne } from "@/lib/turso";

function speechWav(): Buffer {
  const sampleRate = 16_000;
  const n = 12 * sampleRate;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const gate = Math.sin(2 * Math.PI * 2.5 * t) > -0.2 ? 1 : 0;
    const sample = gate * 0.15 * Math.sin(2 * Math.PI * 180 * t);
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  return pcmToWav(pcm, { sampleRate, numChannels: 1, bitDepth: 16 });
}

describe("POST /api/tts/clones youtube source", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.FISH_API_KEY = "test-fish-key";
  });

  it("stores the YouTube url and range with the private clone", async () => {
    const fish = await import("@/lib/tts/providers/fish");
    const create = vi.spyOn(fish, "createFishVoiceClone").mockResolvedValue({
      fishVoiceId: "fish-tab",
      state: "trained",
      title: "Lecture",
    });
    const wav = speechWav();
    const stored = await uploadFile("clones/tab-1", "sample.wav", wav, "audio/wav");
    await insertPendingCloneUpload({
      id: "tab-1",
      userId: USER_A,
      sampleStoragePath: stored.path,
      fileName: "sample.wav",
      contentType: "audio/wav",
      byteSize: stored.size,
    });

    const { POST } = await import("@/app/api/tts/clones/route");
    const response = await POST(
      await buildRequest("/api/tts/clones", {
        method: "POST",
        userId: USER_A,
        body: {
          uploadId: "tab-1",
          title: "Lecture",
          youtube: {
            videoId: "abcdefghijk",
            startSec: 45,
            endSec: 75,
            consent: true,
          },
        },
      })
    );
    expect(response.status).toBe(200);
    const row = await queryOne<{
      source_kind: string;
      source_url: string;
      source_start_sec: number;
      source_end_sec: number;
      source_consented_at: number;
    }>(
      `SELECT source_kind, source_url, source_start_sec, source_end_sec, source_consented_at
       FROM cloned_voices WHERE id = ?`,
      ["tab-1"]
    );
    expect(row?.source_kind).toBe("youtube");
    expect(row?.source_url).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(row?.source_start_sec).toBe(45);
    expect(row?.source_end_sec).toBe(75);
    expect(row?.source_consented_at).toBeGreaterThan(0);
    expect(JSON.stringify(await response.json())).not.toContain("youtube.com");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ enhanceAudioQuality: false, contentType: "audio/wav" })
    );
    expect(create.mock.calls[0]?.[0].audio.equals(wav)).toBe(true);
  });

  it("rejects a YouTube source without consent", async () => {
    const { POST } = await import("@/app/api/tts/clones/route");
    const response = await POST(
      await buildRequest("/api/tts/clones", {
        method: "POST",
        userId: USER_A,
        body: {
          uploadId: "tab-1",
          youtube: {
            videoId: "abcdefghijk",
            startSec: 10,
            endSec: 40,
            consent: false,
          },
        },
      })
    );
    expect(response.status).toBe(400);
  });
});
