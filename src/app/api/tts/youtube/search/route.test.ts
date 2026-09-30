import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";
import {
  clearYoutubeSearchCache,
  forgetYoutubeSearchMemory,
} from "@/lib/youtube/search";
import { GET } from "./route";

const SIGNED_IN = "user_searchlock";
const OTHER = "user_otherreader";
const KEY = "test-youtube-key";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function search(q: string, userId?: string | null) {
  return GET(
    await buildRequest(`/api/tts/youtube/search?q=${encodeURIComponent(q)}`, {
      userId,
    })
  );
}

describe("GET /api/tts/youtube/search", () => {
  beforeEach(async () => {
    await resetDatabase();
    await clearYoutubeSearchCache();
    process.env.YOUTUBE_API_KEY = KEY;
  });

  afterEach(async () => {
    await clearYoutubeSearchCache();
    delete process.env.YOUTUBE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("rejects an anonymous session before it calls YouTube", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const anon = await search("test", USER_A);
    const nobody = await search("test");

    expect(anon.status).toBe(401);
    expect(nobody.status).toBe(401);
    await expect(anon.json()).resolves.toMatchObject({
      code: "SIGN_IN_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches a signed-in search and asks videos.list only for durations", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?")) {
        expect(url).toContain("part=snippet");
        return jsonResponse({
          items: [
            {
              id: { videoId: "abcdefghijk" },
              snippet: { title: "Talk", channelTitle: "CC" },
            },
          ],
        });
      }
      expect(url).toContain("/videos?");
      expect(url).toContain("part=contentDetails");
      expect(url).not.toContain("snippet");
      return jsonResponse({
        items: [{ id: "abcdefghijk", contentDetails: { duration: "PT40S" } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await search("allan bloom", SIGNED_IN);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { results: Array<{ title: string }> };
    expect(body.results[0]?.title).toBe("Talk");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    forgetYoutubeSearchMemory();
    const second = await search("  Allan   Bloom ", OTHER);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The first call already used one of this account's 8 searches.
    for (let i = 0; i < 7; i++) {
      const again = await search("allan bloom", SIGNED_IN);
      expect(again.status).toBe(200);
    }
    const limited = await search("allan bloom", SIGNED_IN);
    expect(limited.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
