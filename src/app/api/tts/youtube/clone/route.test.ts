import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";

describe("YouTube clone routes", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.FISH_API_KEY = "test-fish-key";
    delete process.env.WORKER_URL;
    delete process.env.YOUTUBE_API_KEY;
  });

  it("requires consent and a 10–60s range before calling the worker", async () => {
    const { POST } = await import("@/app/api/tts/youtube/clone/route");
    const missingConsent = await POST(
      await buildRequest("/api/tts/youtube/clone", {
        method: "POST",
        userId: USER_A,
        body: {
          videoId: "abcdefghijk",
          startSec: 10,
          endSec: 40,
          consent: false,
        },
      })
    );
    expect(missingConsent.status).toBe(400);
    expect((await missingConsent.json()).error).toBe(YOUTUBE_COPY.consentRequired);

    const tooShort = await POST(
      await buildRequest("/api/tts/youtube/clone", {
        method: "POST",
        userId: USER_A,
        body: {
          videoId: "abcdefghijk",
          startSec: 0,
          endSec: 8,
          consent: true,
        },
      })
    );
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).error).toBe(YOUTUBE_COPY.rangeInvalid);
  });

  it("returns a friendly fallback when the worker is not configured", async () => {
    const { POST } = await import("@/app/api/tts/youtube/clone/route");
    const response = await POST(
      await buildRequest("/api/tts/youtube/clone", {
        method: "POST",
        userId: USER_A,
        body: {
          videoId: "abcdefghijk",
          startSec: 12,
          endSec: 42,
          consent: true,
          title: "Alex",
        },
      })
    );
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.error).toBe(YOUTUBE_COPY.unavailable);
    expect(body.fallback).toBe("upload");
    expect(JSON.stringify(body)).not.toMatch(/yt-dlp|ffmpeg|Error:/);
  });

  it("does not leak the YouTube API key from search", async () => {
    process.env.YOUTUBE_API_KEY = "super-secret-youtube-key";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "abcdefghijk",
              snippet: { title: "Talk", channelTitle: "CC" },
              contentDetails: { duration: "PT2M" },
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/tts/youtube/search/route");
    const { clearYoutubeSearchCache } = await import("@/lib/youtube/search");
    clearYoutubeSearchCache();
    const response = await GET(
      await buildRequest("/api/tts/youtube/search?q=https://youtu.be/abcdefghijk", {
        userId: USER_A,
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results[0].videoId).toBe("abcdefghijk");
    expect(JSON.stringify(body)).not.toContain("super-secret-youtube-key");
    vi.unstubAllGlobals();
    clearYoutubeSearchCache();
  });
});
