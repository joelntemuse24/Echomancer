import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pcmToWav } from "@/lib/tts/pcm-wav";
import { USER_A, resetDatabase } from "@/test/harness";
import { queryOne } from "@/lib/turso";
import { cloneMayBeShared } from "@/lib/tts/complete-clone";

function drySpeechWav(): Buffer {
  const sampleRate = 16_000;
  const seconds = 12;
  const n = seconds * sampleRate;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const gate = Math.sin(2 * Math.PI * 2.5 * t) > -0.2 ? 1 : 0;
    const sample = gate * 0.15 * Math.sin(2 * Math.PI * 180 * t);
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  return pcmToWav(pcm, { sampleRate, numChannels: 1, bitDepth: 16 });
}

describe("runYoutubeClipJob", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.FISH_API_KEY = "test-fish-key";
  });

  it("stores the YouTube source on a private clone and never marks it shareable", async () => {
    const fish = await import("@/lib/tts/providers/fish");
    const create = vi.spyOn(fish, "createFishVoiceClone").mockResolvedValue({
      fishVoiceId: "fish-yt-test",
      state: "trained",
      title: "Lecture voice",
    });
    const { runYoutubeClipJob } = await import("@/lib/youtube/clip-job");
    const dir = await mkdtemp(path.join(tmpdir(), "yt-job-"));
    const result = await runYoutubeClipJob(
      {
        userId: USER_A,
        videoId: "abcdefghijk",
        startSec: 45,
        endSec: 75,
        title: "Lecture voice",
        accent: "american",
        consent: true,
      },
      {
        download: async () => ({
          strategy: "pot",
          filePath: path.join(dir, "section.m4a"),
          attempts: 1,
        }),
        master: async () => ({
          ok: true,
          clip: {
            wav: drySpeechWav(),
            speechSec: 11,
            denoise: false,
            separated: false,
            judgement: {
              ok: true,
              speechSec: 11,
              denoise: false,
              separateVocals: false,
              musicFraction: 0,
              overlapFraction: 0,
            },
          },
        }),
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("pot");
    expect(result.clone.catalogVoiceId.startsWith("clone:")).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const formTitle = create.mock.calls[0]?.[0].title;
    expect(formTitle).toBe("Lecture voice");

    const row = await queryOne<{
      source_kind: string;
      source_url: string;
      source_start_sec: number;
      source_end_sec: number;
      source_consented_at: number;
    }>(
      `SELECT source_kind, source_url, source_start_sec, source_end_sec, source_consented_at
       FROM cloned_voices WHERE user_id = ?`,
      [USER_A]
    );
    expect(row?.source_kind).toBe("youtube");
    expect(row?.source_url).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(row?.source_start_sec).toBe(45);
    expect(row?.source_end_sec).toBe(75);
    expect(row?.source_consented_at).toBeGreaterThan(0);
    expect(cloneMayBeShared(row?.source_kind)).toBe(false);
    expect(JSON.stringify(result.clone)).not.toContain("youtube.com");
  });
});
