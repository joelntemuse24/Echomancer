import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "./download-client";

function sourceOf(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

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

  it("keeps library and player on the anchor path, not a blob fetch", () => {
    for (const rel of [
      "src/app/dashboard/queue/page.tsx",
      "src/app/dashboard/player/[id]/page.tsx",
    ]) {
      const source = sourceOf(rel);
      expect(source).toContain("startAudiobookDownload");
      expect(source).not.toContain("downloadFromUrl");
      expect(source).not.toContain("res.blob");
      expect(source).toContain("UX.preparingDownload");
      expect(source).toContain("toast.success");
    }
  });
});
