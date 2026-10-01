import { afterEach, describe, expect, it, vi } from "vitest";
import { clearYoutubeSearchCache, searchYoutube } from "./search";

const KEY = "test-youtube-key";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("searchYoutube", () => {
  afterEach(async () => {
    await clearYoutubeSearchCache();
    delete process.env.YOUTUBE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("loads search.list then videos.list durations and caches the query", async () => {
    process.env.YOUTUBE_API_KEY = KEY;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(KEY);
      if (url.includes("/search?")) {
        expect(url).toContain("part=snippet");
        return jsonResponse({
          items: [
            {
              id: { videoId: "abcdefghijk" },
              snippet: {
                title: "Allan Bloom lecture",
                channelTitle: "Lectures",
                thumbnails: {
                  medium: { url: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg" },
                },
              },
            },
            {
              id: { videoId: "zz123456789" },
              snippet: {
                title: "Live now",
                channelTitle: "X",
                liveBroadcastContent: "live",
              },
            },
          ],
        });
      }
      expect(url).toContain("part=contentDetails");
      expect(url).not.toContain("snippet");
      expect(url).toContain("id=abcdefghijk");
      expect(url).not.toContain("zz123456789");
      return jsonResponse({
        items: [
          {
            id: "abcdefghijk",
            contentDetails: { duration: "PT1H2M3S" },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await searchYoutube("Allan Bloom lecture");
    const second = await searchYoutube("  allan   bloom lecture ");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      videoId: "abcdefghijk",
      title: "Allan Bloom lecture",
      channel: "Lectures",
      durationSec: 3723,
    });
    expect(first[0]?.suggestedRange).toEqual({ startSec: 45, endSec: 65 });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain(KEY);
  });

  it("resolves a pasted link with videos.list contentDetails only", async () => {
    process.env.YOUTUBE_API_KEY = KEY;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("part=contentDetails");
      expect(url).not.toContain("snippet");
      expect(url).not.toContain("/search?");
      return jsonResponse({
        items: [
          {
            id: "abcdefghijk",
            contentDetails: { duration: "PT40S" },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const hits = await searchYoutube("https://youtu.be/abcdefghijk");
    expect(hits[0]?.title).toBe("YouTube video");
    expect(hits[0]?.channel).toBe("");
    expect(hits[0]?.durationSec).toBe(40);
    expect(hits[0]?.thumbnailUrl).toContain("abcdefghijk");
    expect(hits[0]?.suggestedRange).toEqual({ startSec: 0, endSec: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
