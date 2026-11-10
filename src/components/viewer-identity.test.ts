import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadViewerIdentity,
  peekViewerIdentity,
  resetViewerIdentityCache,
} from "@/components/viewer-identity";
import {
  SCREEN_JOBS,
  peekScreen,
  putScreen,
  resetScreenCache,
} from "@/lib/nav/screen-cache";

afterEach(() => {
  resetViewerIdentityCache();
  resetScreenCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function viewerResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("viewer identity cache", () => {
  it("does not store a 503 as signed out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(viewerResponse({ error: "down" }, 503))
      .mockResolvedValueOnce(
        viewerResponse({
          signedIn: true,
          markup: false,
          key: "aaaaaaaaaaaaaaaa",
          name: "Ada",
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadViewerIdentity()).rejects.toThrow("503");
    expect(peekViewerIdentity()).toBeNull();

    const next = await loadViewerIdentity();
    expect(next.signedIn).toBe(true);
    expect(next.name).toBe("Ada");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears screen caches when the viewer key changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        viewerResponse({ signedIn: false, markup: false, key: "aaaaaaaaaaaaaaaa" })
      )
      .mockResolvedValueOnce(
        viewerResponse({
          signedIn: true,
          markup: false,
          key: "bbbbbbbbbbbbbbbb",
          name: "Ada",
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await loadViewerIdentity();
    putScreen(SCREEN_JOBS, { jobs: [{ id: "anon-book" }] });
    expect(peekScreen(SCREEN_JOBS)).not.toBeNull();

    const next = await loadViewerIdentity({ force: true });
    expect(next.signedIn).toBe(true);
    expect(peekScreen(SCREEN_JOBS)).toBeNull();
  });

  it("does not let a slower response replace a newer identity", async () => {
    let resolveFirst: (response: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(
        viewerResponse({ signedIn: false, markup: false, key: "bbbbbbbbbbbbbbbb" })
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = loadViewerIdentity();
    const second = await loadViewerIdentity({ force: true });
    expect(second.signedIn).toBe(false);

    resolveFirst(
      viewerResponse({
        signedIn: true,
        markup: false,
        key: "aaaaaaaaaaaaaaaa",
        name: "Old",
      })
    );
    await first;

    expect(peekViewerIdentity()?.signedIn).toBe(false);
    expect(peekViewerIdentity()?.key).toBe("bbbbbbbbbbbbbbbb");
  });
});
