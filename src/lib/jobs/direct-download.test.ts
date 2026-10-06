import { beforeEach, describe, expect, it, vi } from "vitest";
import { isSectionStoragePath } from "@/lib/tts/concat-audio";

const directObjectUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  directObjectUrl,
}));

import { downloadFilename, isSectionPath, withDirectDownloadUrl } from "./direct-download";

beforeEach(() => {
  directObjectUrl.mockReset();
  directObjectUrl.mockResolvedValue("https://r2.example/signed");
});

describe("withDirectDownloadUrl", () => {
  it("links a ready full file with the download route's file name", async () => {
    const out = await withDirectDownloadUrl(
      { id: "j" },
      { status: "ready", audio_storage_path: "audiobooks/j/full.mp3", book_title: "War & Peace" }
    );
    expect(out.download_url).toBe("https://r2.example/signed");
    expect(directObjectUrl).toHaveBeenCalledWith("audiobooks/j/full.mp3", {
      downloadName: "war_peace.mp3",
    });
  });

  it.each([
    { status: "processing", audio_storage_path: "audiobooks/j/full.mp3" },
    { status: "ready", audio_storage_path: "audiobooks/j/sections/0000.mp3" },
    { status: "ready", audio_storage_path: null },
  ])("skips %o", async (job) => {
    const out = await withDirectDownloadUrl({ id: "j" }, job);
    expect(out).not.toHaveProperty("download_url");
    expect(directObjectUrl).not.toHaveBeenCalled();
  });

  it("keeps the fallback when presigning is off or fails", async () => {
    directObjectUrl.mockResolvedValueOnce(null);
    const job = { status: "ready", audio_storage_path: "audiobooks/j/full.mp3" };
    expect(await withDirectDownloadUrl({ id: "j" }, job)).not.toHaveProperty("download_url");
    directObjectUrl.mockRejectedValueOnce(new Error("boom"));
    expect(await withDirectDownloadUrl({ id: "j" }, job)).not.toHaveProperty("download_url");
  });
});

describe("helpers", () => {
  it("agrees with concat-audio on section paths", () => {
    for (const p of ["audiobooks/j/sections/0001.mp3", "audiobooks/j/full.mp3", "a/sections", "x/sections/y"]) {
      expect(isSectionPath(p)).toBe(isSectionStoragePath(p));
    }
  });

  it("names the file like the download route", () => {
    expect(downloadFilename(null, "audiobooks/j/full.m4a")).toBe("audiobook.m4a");
    expect(downloadFilename("A History", "audiobooks/j/full")).toBe("a_history.mp3");
  });
});
