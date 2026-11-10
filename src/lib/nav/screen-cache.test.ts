import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCREEN_FRESH_MS,
  SCREEN_JOBS,
  SCREEN_VOICES,
  forgetJob,
  invalidateScreen,
  loadScreen,
  peekJob,
  putScreen,
  rememberJobDetail,
  rememberJobsList,
  resetScreenCache,
  screenCachedAt,
} from "./screen-cache";

afterEach(() => {
  resetScreenCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("screen cache", () => {
  it("paints a fresh payload and still refetches on the next read", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ jobs: [{ id: "job-a" }, { id: "job-b" }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadScreen<{ jobs: { id: string }[] }>(SCREEN_JOBS, "/api/jobs");
    const second = await loadScreen<{ jobs: { id: string }[] }>(SCREEN_JOBS, "/api/jobs");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.jobs.map((job) => job.id)).toEqual(["job-a", "job-b"]);
    expect(second).toEqual(first);
    expect(peekJob("job-a")).toEqual({ id: "job-a" });
  });

  it("lets a warmup reuse a fresh payload and an in-flight request", async () => {
    let respond: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = loadScreen(SCREEN_VOICES, "/api/tts/voices", { warm: true });
    const second = loadScreen(SCREEN_VOICES, "/api/tts/voices", { warm: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    respond(jsonResponse({ voices: [{ id: "standard" }] }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { voices: [{ id: "standard" }] },
      { voices: [{ id: "standard" }] },
    ]);

    fetchMock.mockClear();
    await loadScreen(SCREEN_VOICES, "/api/tts/voices", { warm: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not extend freshness when the list is edited locally", async () => {
    putScreen(SCREEN_JOBS, { jobs: [{ id: "old" }] }, 1_000);
    rememberJobsList({ jobs: [{ id: "old", book_title: "Renamed" }] });
    expect(screenCachedAt(SCREEN_JOBS)).toBe(1_000);

    const fetchMock = vi.fn(async () => jsonResponse({ jobs: [{ id: "created" }] }));
    vi.stubGlobal("fetch", fetchMock);
    putScreen(SCREEN_JOBS, { jobs: [{ id: "old" }] }, Date.now());
    invalidateScreen(SCREEN_JOBS);
    const next = await loadScreen<{ jobs: { id: string }[] }>(SCREEN_JOBS, "/api/jobs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(next.jobs[0]?.id).toBe("created");
  });

  it("drops a book that a fresh list no longer contains", async () => {
    rememberJobDetail("gone", { job: { id: "gone", book_title: "Old" } });
    const fetchMock = vi.fn(async () => jsonResponse({ jobs: [{ id: "kept" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await loadScreen(SCREEN_JOBS, "/api/jobs");
    expect(peekJob("gone")).toBeNull();
    expect(peekJob("kept")).toEqual({ id: "kept" });
    forgetJob("kept");
    expect(peekJob("kept")).toBeNull();
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
    expect(screenCachedAt(SCREEN_JOBS)).toBe(0);
  });

  it("still refetches inside the freshness window", async () => {
    putScreen(SCREEN_VOICES, { voices: [] }, Date.now() - SCREEN_FRESH_MS + 1_000);
    const fetchMock = vi.fn(async () => jsonResponse({ voices: [{ id: "ava" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const next = await loadScreen<{ voices: { id: string }[] }>(
      SCREEN_VOICES,
      "/api/tts/voices"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(next.voices[0]?.id).toBe("ava");
  });
});
