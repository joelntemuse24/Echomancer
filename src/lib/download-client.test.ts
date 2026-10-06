import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audiobookDownloadUrl,
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "./download-client";

describe("audiobook download", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the file from the book title", () => {
    expect(audiobookFilename("The Quay")).toBe("the_quay.mp3");
    expect(audiobookFilename("")).toBe("audiobook.mp3");
  });

  it("treats iPhone and iPadOS as the open-or-save path", () => {
    expect(
      isIosDownload({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        platform: "iPhone",
        maxTouchPoints: 5,
      })
    ).toBe(true);
    expect(
      isIosDownload({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      })
    ).toBe(true);
    expect(
      isIosDownload({
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
        platform: "Win32",
        maxTouchPoints: 0,
      })
    ).toBe(false);
  });

  it("starts a same-origin download without fetching the file into a blob", () => {
    const clicked: string[] = [];
    const anchors: Array<{ href: string; download: string; target: string }> = [];
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      platform: "Win32",
      maxTouchPoints: 0,
    });
    vi.stubGlobal("fetch", () => {
      throw new Error("download must not blob-fetch the audiobook");
    });
    vi.stubGlobal("document", {
      body: {
        appendChild() {},
      },
      createElement() {
        const el = {
          href: "",
          download: "",
          rel: "",
          target: "",
          click() {
            clicked.push(el.href);
          },
          remove() {},
        };
        anchors.push(el);
        return el;
      },
    });

    const result = startAudiobookDownload(
      "/api/jobs/job-1/download",
      "the_quay.mp3"
    );

    expect(result).toBeUndefined();
    expect(clicked).toEqual(["/api/jobs/job-1/download"]);
    expect(anchors[0]?.download).toBe("the_quay.mp3");
    expect(anchors[0]?.target).toBe("");
    expect(anchors[0]?.href.startsWith("blob:")).toBe(false);
  });

  it("saves in the same window on desktop Chrome, Edge, and Firefox", () => {
    const desktops = [
      {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        platform: "Win32",
        maxTouchPoints: 0,
      },
      {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
        platform: "Win32",
        maxTouchPoints: 0,
      },
      {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
        platform: "Linux x86_64",
        maxTouchPoints: 0,
      },
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 0,
      },
    ];

    for (const nav of desktops) {
      const anchors: Array<{ href: string; download: string; target: string }> = [];
      vi.stubGlobal("navigator", nav);
      vi.stubGlobal("fetch", () => {
        throw new Error("download must not blob-fetch the audiobook");
      });
      vi.stubGlobal("document", {
        body: { appendChild() {} },
        createElement() {
          const el = {
            href: "",
            download: "",
            rel: "",
            target: "",
            click() {},
            remove() {},
          };
          anchors.push(el);
          return el;
        },
      });

      startAudiobookDownload("/api/jobs/job-1/download", "the_quay.mp3");
      expect(isIosDownload(nav)).toBe(false);
      expect(anchors[0]?.target).toBe("");
      expect(anchors[0]?.download).toBe("the_quay.mp3");
      expect(anchors[0]?.href).toBe("/api/jobs/job-1/download");
      vi.unstubAllGlobals();
    }
  });

  it("opens the file on iOS so the share sheet can save it", () => {
    const anchors: Array<{ href: string; download: string; target: string }> = [];
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    vi.stubGlobal("document", {
      body: { appendChild() {} },
      createElement() {
        const el = {
          href: "",
          download: "",
          rel: "",
          target: "",
          click() {},
          remove() {},
        };
        anchors.push(el);
        return el;
      },
    });

    startAudiobookDownload("/api/jobs/job-1/download", "the_quay.mp3");
    expect(anchors[0]?.target).toBe("_blank");
    expect(anchors[0]?.href).toBe("/api/jobs/job-1/download");
  });
});

describe("audiobookDownloadUrl", () => {
  const signedAt = Date.UTC(2026, 9, 6, 22, 0, 0);
  const fresh = `https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Date=20261006T220000Z&X-Amz-Expires=46800`;
  const fallback = "/api/jobs/j/download";

  it("uses a signature that still has time left", () => {
    expect(audiobookDownloadUrl(fresh, fallback, signedAt + 60_000)).toBe(fresh);
  });

  it("refuses a signature inside the last minute", () => {
    const almostGone = signedAt + 46800 * 1000 - 30_000;
    expect(audiobookDownloadUrl(fresh, fallback, almostGone)).toBeNull();
  });

  it("keeps the same-origin route when the book has no direct link", () => {
    expect(audiobookDownloadUrl(undefined, fallback, signedAt)).toBe(fallback);
  });

  it("keeps a URL that is not a SigV4 GET", () => {
    expect(audiobookDownloadUrl("https://example.com/file.mp3", fallback)).toBe(
      "https://example.com/file.mp3"
    );
  });
});
