import { describe, expect, it } from "vitest";
import { shouldReloadStorageAfterError } from "./storage-reload";

describe("shouldReloadStorageAfterError", () => {
  it("reloads a storage URL once after a network or unsupported-src error", () => {
    expect(
      shouldReloadStorageAfterError({
        src: "/api/storage/audiobooks/j/full.mp3",
        errorCode: 2,
        alreadyReloaded: false,
      })
    ).toBe(true);
    expect(
      shouldReloadStorageAfterError({
        src: "/api/storage/audiobooks/j/sections/0001.mp3",
        errorCode: 4,
        alreadyReloaded: false,
      })
    ).toBe(true);
  });

  it("does not reload twice, or for a stream, or for a decode error", () => {
    expect(
      shouldReloadStorageAfterError({
        src: "/api/storage/audiobooks/j/full.mp3",
        errorCode: 2,
        alreadyReloaded: true,
      })
    ).toBe(false);
    expect(
      shouldReloadStorageAfterError({
        src: "/api/jobs/j/stream",
        errorCode: 2,
        alreadyReloaded: false,
      })
    ).toBe(false);
    expect(
      shouldReloadStorageAfterError({
        src: "/api/storage/audiobooks/j/full.mp3",
        errorCode: 3,
        alreadyReloaded: false,
      })
    ).toBe(false);
    expect(
      shouldReloadStorageAfterError({
        src: "/api/storage/audiobooks/j/full.mp3",
        errorCode: 1,
        alreadyReloaded: false,
      })
    ).toBe(false);
  });
});
