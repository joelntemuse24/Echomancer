/**
 * Live Listen must fail as JSON, never an uncaught Next.js HTML /500.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import { INITIAL_SLOW_SPEED } from "@/lib/tts/narration-pace";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FISH_API_KEY;
});

beforeEach(async () => {
  await resetDatabase();
  process.env.FISH_API_KEY = "test-key";
});

describe("GET /api/tts/live", () => {
  it("returns JSON when Fish answers 400 Reference not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: "Reference not found",
              status: 400,
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          )
      )
    );

    const { GET } = await import("@/app/api/tts/live/route");
    const response = await GET(
      await buildRequest(
        "/api/tts/live?catalogVoiceId=fish-narrator",
        { userId: USER_A, method: "GET" }
      )
    );

    const contentType = response.headers.get("content-type") || "";
    expect(contentType).toMatch(/json/i);
    expect(contentType).not.toMatch(/html/i);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);

    const body = (await response.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);
    expect(String(body.error)).not.toMatch(/<!DOCTYPE html>/i);
  });

  it("sends Fish prosody.speed for a clone Live Listen", async () => {
    const clone = await insertClonedVoice({
      id: "96a74157-aaaa-4bbb-8ccc-ddddeeeeffff",
      userId: USER_A,
      fishVoiceId: "fish-ref-wolfe",
      title: "Wolfe",
      state: "trained",
      model: "s2.1-pro-free",
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/tts/live/route");
    const response = await GET(
      await buildRequest(
        `/api/tts/live?catalogVoiceId=${catalogIdForClone(clone.id)}`,
        { userId: USER_A, method: "GET" }
      )
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      latency?: string;
      prosody?: { speed?: number };
    };
    expect(body.latency).toBe("balanced");
    expect(body.prosody?.speed).toBe(INITIAL_SLOW_SPEED);
  });

  it("omits Fish prosody for stock Narrator on the short preview line", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/tts/live/route");
    const response = await GET(
      await buildRequest("/api/tts/live?catalogVoiceId=fish-narrator", {
        userId: USER_A,
        method: "GET",
      })
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      latency?: string;
      prosody?: { speed?: number };
    };
    expect(body.latency).toBe("balanced");
    expect(body.prosody).toBeUndefined();
  });
});
