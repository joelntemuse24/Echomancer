/**
 * Live Listen must fail as JSON, never an uncaught Next.js HTML /500.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";

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
});
