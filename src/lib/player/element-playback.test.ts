import { describe, expect, it } from "vitest";
import {
  PLAYBACK_STATE_EVENTS,
  elementIsPlaying,
  partIndexForSrc,
  samePlaybackSource,
} from "./element-playback";

describe("elementIsPlaying", () => {
  it("is true for an element that is playing", () => {
    expect(
      elementIsPlaying({ paused: false, ended: false, readyState: 4, error: null })
    ).toBe(true);
  });

  it("is false while paused, at the end, or with no element", () => {
    expect(
      elementIsPlaying({ paused: true, ended: false, readyState: 4, error: null })
    ).toBe(false);
    expect(
      elementIsPlaying({ paused: false, ended: true, readyState: 4, error: null })
    ).toBe(false);
    expect(elementIsPlaying(null)).toBe(false);
    expect(elementIsPlaying(undefined)).toBe(false);
  });
});

describe("samePlaybackSource", () => {
  it("ignores the query, so a cache-busted URL is the same file", () => {
    expect(
      samePlaybackSource("/api/storage/full.mp3", "/api/storage/full.mp3?r=2")
    ).toBe(true);
    expect(
      samePlaybackSource("/api/storage/full.mp3?r=2", "/api/storage/full.mp3?r=3")
    ).toBe(true);
    expect(
      samePlaybackSource(
        "/api/storage/audiobooks/x/full.mp3?v=2026&pb=2",
        "/api/storage/audiobooks/x/full.mp3"
      )
    ).toBe(true);
  });

  it("is false for a different file, or for nothing at all", () => {
    expect(
      samePlaybackSource("/api/storage/full.mp3", "/api/storage/sections/0001.mp3")
    ).toBe(false);
    expect(samePlaybackSource(null, "/api/storage/full.mp3")).toBe(false);
    expect(samePlaybackSource("", "")).toBe(false);
  });
});

describe("partIndexForSrc", () => {
  const parts = [
    { index: 0, url: "/api/storage/part-0.mp3" },
    { index: 1, url: "/api/storage/part-1.mp3" },
    { index: 2 },
  ];

  it("finds the part the element holds, ignoring a cache-busting query", () => {
    expect(partIndexForSrc(parts, "/api/storage/part-1.mp3?r=1")).toBe(1);
    expect(partIndexForSrc(parts, "/api/storage/part-0.mp3")).toBe(0);
  });

  it("is null for a single-file book or a part the page has no URL for", () => {
    expect(partIndexForSrc(parts, "/api/storage/audiobooks/x/full.mp3")).toBeNull();
    expect(partIndexForSrc([], "/api/storage/part-0.mp3")).toBeNull();
    expect(partIndexForSrc(parts, null)).toBeNull();
  });
});

describe("PLAYBACK_STATE_EVENTS", () => {
  it("covers every event that can change the play/pause reading", () => {
    expect([...PLAYBACK_STATE_EVENTS]).toEqual([
      "play",
      "playing",
      "pause",
      "ended",
      "emptied",
      "loadedmetadata",
    ]);
  });
});
