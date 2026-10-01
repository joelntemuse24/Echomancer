import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "@/lib/turso";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";
import { resetClipProxyCache } from "@/lib/youtube/clip-access";
import { getYoutubeClipForUser } from "@/lib/youtube/clip-store";
import { GET as getClip } from "./[id]/route";
import { GET, POST } from "./route";

const USER = "user_proxyclip";
const EMAIL = "joel@example.com";
const VIDEO = "abcdefghijk";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function videoItem(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: VIDEO,
        snippet: { liveBroadcastContent: "none" },
        contentDetails: { duration: "PT5M" },
        status: { privacyStatus: "public" },
        ...overrides,
      },
    ],
  };
}

describe("proxy clip routes", () => {
  beforeEach(async () => {
    await resetDatabase();
    resetClipProxyCache();
    process.env.YT_SERVER_CLIPS_EMAILS = EMAIL;
    process.env.YOUTUBE_API_KEY = "yt-test-key";
    process.env.WORKER_URL = "http://worker.test";
    process.env.WORKER_SECRET = "sek";
    await execute(
      `INSERT INTO users (id, google_sub, email, email_verified) VALUES (?, ?, ?, 1)`,
      [USER, "google-joel", EMAIL]
    );
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return json({ ok: true, clipProvider: "apify" });
      if (url.includes("/clips/wake")) return json({ ok: true });
      if (url.includes("googleapis.com/youtube/v3/videos")) return json(videoItem());
      return json({ error: url }, 500);
    }));
  });

  afterEach(() => {
    resetClipProxyCache();
    delete process.env.YT_SERVER_CLIPS_EMAILS;
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.WORKER_URL;
    delete process.env.WORKER_SECRET;
    vi.unstubAllGlobals();
  });

  async function post(userId: string, body: unknown) {
    return POST(
      await buildRequest("/api/clips", { method: "POST", userId, body })
    );
  }

  it("hides the path from other accounts", async () => {
    const anon = await GET(await buildRequest("/api/clips", { userId: USER_A }));
    expect(await anon.json()).toEqual({ enabled: false });
    process.env.YT_SERVER_CLIPS_EMAILS = "someone-else@example.com";
    resetClipProxyCache();
    const hidden = await GET(await buildRequest("/api/clips", { userId: USER }));
    expect(await hidden.json()).toEqual({ enabled: false });
    const denied = await post(USER, {
      videoId: VIDEO,
      startSeconds: 10,
      lengthSeconds: 20,
      consent: true,
    });
    expect(denied.status).toBe(404);
  });

  it("queues a section for the allowlisted account", async () => {
    const enabled = await GET(await buildRequest("/api/clips", { userId: USER }));
    expect(await enabled.json()).toEqual({ enabled: true });
    const created = await post(USER, {
      videoId: VIDEO,
      startSeconds: 10,
      lengthSeconds: 20,
      consent: true,
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");
    const row = await getYoutubeClipForUser(USER, body.id);
    expect(row?.length_seconds).toBe(20);
    expect(Number(row?.consent_at)).toBeGreaterThan(0);

    const status = await getClip(
      await buildRequest(`/api/clips/${body.id}`, { userId: USER }),
      { params: Promise.resolve({ id: body.id }) }
    );
    expect(await status.json()).toMatchObject({
      id: body.id,
      status: "queued",
      error: null,
      downloadUrl: null,
    });
    const other = await getClip(
      await buildRequest(`/api/clips/${body.id}`, { userId: "user_otherperson" }),
      { params: Promise.resolve({ id: body.id }) }
    );
    expect(other.status).toBe(404);
  });

  it("rejects restricted videos and a window past the end", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return json({ ok: true, clipProvider: "apify" });
      if (url.includes("googleapis.com")) {
        return json(videoItem({ status: { privacyStatus: "private" } }));
      }
      return json({ ok: true });
    });
    const restricted = await post(USER, {
      videoId: VIDEO,
      startSeconds: 0,
      lengthSeconds: 20,
      consent: true,
    });
    expect(restricted.status).toBe(400);
    expect(await restricted.json()).toMatchObject({ code: "restricted" });

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return json({ ok: true, clipProvider: "apify" });
      if (url.includes("googleapis.com")) {
        return json({
          items: [
            {
              id: VIDEO,
              snippet: { liveBroadcastContent: "none" },
              contentDetails: { duration: "PT5M", contentRating: { ytRating: "ytAgeRestricted" } },
              status: { privacyStatus: "public" },
            },
          ],
        });
      }
      return json({ ok: true });
    });
    const aged = await post(USER, {
      videoId: VIDEO,
      startSeconds: 0,
      lengthSeconds: 20,
      consent: true,
    });
    expect(aged.status).toBe(400);
    expect(await aged.json()).toMatchObject({ code: "restricted" });

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return json({ ok: true, clipProvider: "apify" });
      if (url.includes("googleapis.com")) return json(videoItem());
      return json({ ok: true });
    });
    const past = await post(USER, {
      videoId: VIDEO,
      startSeconds: 290,
      lengthSeconds: 20,
      consent: true,
    });
    expect(past.status).toBe(400);
    expect(await past.json()).toMatchObject({ code: "range_unsupported" });
  });

  it("returns 429 once the daily count is used", async () => {
    for (let i = 0; i < 15; i++) {
      await execute(
        `INSERT INTO youtube_clips (
           id, user_id, video_id, start_seconds, length_seconds, status,
           bytes_proxy, consent_at, attempts, created_at
         ) VALUES (?, ?, ?, 0, 20, 'failed', 0, 1, 1, ?)`,
        [`cap-${i}`, USER, VIDEO, Math.floor(Date.now() / 1000)]
      );
    }
    const limited = await post(USER, {
      videoId: VIDEO,
      startSeconds: 10,
      lengthSeconds: 20,
      consent: true,
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "budget" });
  });
});
