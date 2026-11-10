import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCREEN_FRESH_MS,
  SCREEN_JOBS,
  SCREEN_VOICES,
  loadScreen,
  peekJob,
  peekScreen,
  putScreen,
  rememberJobDetail,
  rememberJobsList,
  resetScreenCache,
} from "./screen-cache";

afterEach(() => {
  resetScreenCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("screen cache", () => {
  it("reuses a fresh payload and seeds each book for the player", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ jobs: [{ id: "job-a" }, { id: "job-b" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadScreen<{ jobs: { id: string }[] }>(SCREEN_JOBS, "/api/jobs");
    const second = await loadScreen(SCREEN_JOBS, "/api/jobs");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(peekJob("job-a")).toEqual({ id: "job-a" });
    expect(peekJob("job-b")).toEqual({ id: "job-b" });
  });

  it("shares one request while the first is still in flight", async () => {
    let respond: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = loadScreen(SCREEN_VOICES, "/api/tts/voices");
    const second = loadScreen(SCREEN_VOICES, "/api/tts/voices");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond(
      new Response(JSON.stringify({ voices: [{ id: "standard" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(Promise.all([first, second])).resolves.toEqual([
      { voices: [{ id: "standard" }] },
      { voices: [{ id: "standard" }] },
    ]);
  });

  it("fetches again once the fresh window has passed", async () => {
    putScreen(SCREEN_VOICES, { voices: [] }, Date.now() - SCREEN_FRESH_MS - 5);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ voices: [{ id: "ava" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const next = await loadScreen<{ voices: { id: string }[] }>(
      SCREEN_VOICES,
      "/api/tts/voices"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(next.voices[0]?.id).toBe("ava");
    expect(peekScreen(SCREEN_VOICES)).toEqual(next);
  });

  it("keeps a player payload that already has chapters", () => {
    rememberJobDetail("job-a", {
      job: { id: "job-a", book_title: "Kept", chapters: [{ title: "One" }] },
    });
    rememberJobsList({
      jobs: [
        { id: "job-a", book_title: "Summary" },
        { id: "job-b", book_title: "Other" },
      ],
    });

    expect(peekJob("job-a")).toEqual({
      id: "job-a",
      book_title: "Kept",
      chapters: [{ title: "One" }],
    });
    expect(peekJob("job-b")).toEqual({ id: "job-b", book_title: "Other" });
  });
});
