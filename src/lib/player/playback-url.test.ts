import { describe, expect, it } from "vitest";
import {
  PLAYBACK_CONTRACT,
  cacheBustPlaybackUrl,
  playbackRecoveryCount,
  versionedAudioUrl,
} from "./playback-url";

describe("versionedAudioUrl", () => {
  it("stamps a storage URL with the playback contract even when updated_at is missing", () => {
    expect(versionedAudioUrl("/api/storage/audiobooks/j/full.mp3", null)).toBe(
      `/api/storage/audiobooks/j/full.mp3?pb=${PLAYBACK_CONTRACT}`
    );
  });

  it("keeps the book version and the contract on one query", () => {
    expect(
      versionedAudioUrl("/api/storage/audiobooks/j/full.mp3", "2026-11-09T12:00:00Z")
    ).toBe(
      `/api/storage/audiobooks/j/full.mp3?v=2026-11-09T12%3A00%3A00Z&pb=${PLAYBACK_CONTRACT}`
    );
  });

  it("leaves a live stream URL alone", () => {
    expect(versionedAudioUrl("/api/jobs/j/stream", "1")).toBe("/api/jobs/j/stream");
    expect(versionedAudioUrl(null, "1")).toBeNull();
  });
});

describe("cacheBustPlaybackUrl", () => {
  it("moves the cache key once, then counts the next recovery", () => {
    const first = cacheBustPlaybackUrl(
      `/api/storage/audiobooks/j/full.mp3?pb=${PLAYBACK_CONTRACT}`
    );
    expect(first).toContain("r=1");
    expect(playbackRecoveryCount(first)).toBe(1);
    expect(cacheBustPlaybackUrl(first)).toContain("r=2");
  });
});
