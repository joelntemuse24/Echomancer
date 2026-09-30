/**
 * Full search → section download → master → clone.
 * Skipped in CI. Run on the worker:
 *   RUN_YOUTUBE_INTEGRATION=1 npx vitest run src/lib/youtube/clone-pipeline.integration.test.ts
 *
 * Uses a known Creative Commons video. Fish is mocked unless
 * YOUTUBE_CLONE_LIVE_FISH=1, so a test run does not publish a voice.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ENABLED = process.env.RUN_YOUTUBE_INTEGRATION === "1";

/** Creative Commons film "Wanna Work Together?" (channel: Creative Commons). */
export const CC_SPEECH_VIDEO_ID = process.env.YOUTUBE_CC_VIDEO_ID || "q0VzUigrb_g";

describe.skipIf(!ENABLED)("youtube clone pipeline", () => {
  it(
    "searches, clips, masters, and clones a Creative Commons video",
    async () => {
      const { searchYoutube } = await import("@/lib/youtube/search");
      const { downloadYoutubeSection } = await import("@/lib/youtube/fetch-audio");
      const { masterYoutubeClip } = await import("@/lib/youtube/master-clip");
      const { runYoutubeClipJob } = await import("@/lib/youtube/clip-job");
      const { resetDatabase, USER_A } = await import("@/test/harness");

      await resetDatabase();
      process.env.FISH_API_KEY = process.env.FISH_API_KEY || "test-fish-key";
      if (process.env.YOUTUBE_CLONE_LIVE_FISH !== "1") {
        const fish = await import("@/lib/tts/providers/fish");
        vi.spyOn(fish, "createFishVoiceClone").mockResolvedValue({
          fishVoiceId: "fish-cc-test",
          state: "trained",
          title: "CC voice",
        });
      }

      const started = Date.now();
      const hits = await searchYoutube(CC_SPEECH_VIDEO_ID);
      const searchMs = Date.now() - started;
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits[0]!;
      expect(hit.videoId).toBe(CC_SPEECH_VIDEO_ID);
      const range = hit.suggestedRange ?? { startSec: 20, endSec: 50 };

      const workDir = await mkdtemp(path.join(tmpdir(), "yt-int-"));
      const fetchStarted = Date.now();
      const fetched = await downloadYoutubeSection({
        videoId: hit.videoId,
        startSec: range.startSec,
        endSec: range.endSec,
        workDir,
      });
      const fetchMs = Date.now() - fetchStarted;
      expect(fetched.filePath).toBeTruthy();
      const probed = await import("@/lib/youtube/fetch-audio").then((mod) =>
        mod.probeMediaDuration(fetched.filePath)
      );
      if (probed != null) {
        expect(probed).toBeLessThanOrEqual(range.endSec - range.startSec + 8);
      }

      const masterStarted = Date.now();
      const mastered = await masterYoutubeClip(fetched.filePath);
      const masterMs = Date.now() - masterStarted;
      expect(mastered.ok).toBe(true);
      if (!mastered.ok) return;

      const cloneStarted = Date.now();
      const cloned = await runYoutubeClipJob(
        {
          userId: USER_A,
          videoId: hit.videoId,
          startSec: range.startSec,
          endSec: range.endSec,
          title: "CC voice",
          consent: true,
        },
        {
          download: async () => fetched,
          master: async () => mastered,
        }
      );
      const cloneMs = Date.now() - cloneStarted;

      console.info(
        JSON.stringify({
          videoId: hit.videoId,
          strategy: fetched.strategy,
          searchMs,
          fetchMs,
          masterMs,
          cloneMs,
          speechSec: mastered.clip.speechSec,
          cloneOk: cloned.ok,
        })
      );

      expect(cloned.ok).toBe(true);
      if (!cloned.ok) return;
      const { queryOne } = await import("@/lib/turso");
      const row = await queryOne<{ source_kind: string; source_url: string }>(
        `SELECT source_kind, source_url FROM cloned_voices WHERE user_id = ?`,
        [USER_A]
      );
      expect(row?.source_kind).toBe("youtube");
      expect(row?.source_url).toContain(hit.videoId);
    },
    120_000
  );
});
