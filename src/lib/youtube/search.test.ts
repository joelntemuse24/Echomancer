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
  afterEach(() => {
    clearYoutubeSearchCache();
    delete process.env.YOUTUBE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("loads search.list then videos.list and caches the query", async () => {
    process.env.YOUTUBE_API_KEY = KEY;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(KEY);
      if (url.includes("/search?")) {
        return jsonResponse({
          items: [
            { id: { videoId: "abcdefghijk" } },
            { id: { videoId: "zz123456789" } },
          ],
        });
      }
      return jsonResponse({
        items: [
          {
            id: "abcdefghijk",
            snippet: {
              title: "Allan Bloom lecture",
              channelTitle: "Lectures",
              thumbnails: { medium: { url: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg" } },
            },
            contentDetails: { duration: "PT1H2M3S" },
          },
          {
            id: "zz123456789",
            snippet: { title: "Live now", channelTitle: "X", liveBroadcastContent: "live" },
            contentDetails: { duration: "PT1H" },
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
    expect(first[0]?.suggestedRange).toEqual({ startSec: 45, endSec: 75 });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain(KEY);
  });

  it("resolves a pasted link with videos.list only", async () => {
    process.env.YOUTUBE_API_KEY = KEY;
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [
          {
            id: "abcdefghijk",
            snippet: { title: "Talk", channelTitle: "CC" },
            contentDetails: { duration: "PT40S" },
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const hits = await searchYoutube("https://youtu.be/abcdefghijk");
    expect(hits[0]?.durationSec).toBe(40);
    expect(hits[0]?.suggestedRange).toEqual({ startSec: 0, endSec: 30 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/videos?");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/search?");
  });
});
