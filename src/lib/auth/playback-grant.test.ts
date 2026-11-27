import { describe, expect, it } from "vitest";
import {
  playbackRowAllows,
  readPlaybackGrant,
  signPlaybackGrant,
} from "@/lib/auth/playback-grant";

describe("playback grant", () => {
  it("allows the signed folder until the window ends", () => {
    const now = 1_700_000_000_000;
    const token = signPlaybackGrant("user_a", "audiobooks/job1", now, 0);
    expect(readPlaybackGrant("user_a", "audiobooks/job1/sections/0001.mp3", token, now)).toEqual({
      prefix: "audiobooks/job1",
      nonce: 0,
    });
    expect(readPlaybackGrant("user_a", "audiobooks/job1/full.mp3", token, now)?.nonce).toBe(0);
    expect(readPlaybackGrant("user_b", "audiobooks/job1/full.mp3", token, now)).toBeNull();
    expect(readPlaybackGrant("user_a", "audiobooks/other/full.mp3", token, now)).toBeNull();
    expect(readPlaybackGrant("user_a", "audiobooks/job1/full.mp3", token, now + 10 * 60_000)).toBeNull();
    expect(signPlaybackGrant("user_a", "audiobooks/job1", now + 1000, 0)).toBe(token);
  });

  it("stops a grant that still has minutes left once the row nonce changes or the book is deleted", () => {
    const now = 100_001;
    const token = signPlaybackGrant("user_a", "audiobooks/job1", now, 0);
    const later = now + 2 * 60_000;
    expect(readPlaybackGrant("user_a", "audiobooks/job1/live/0000.mp3", token, later)?.nonce).toBe(0);
    const row = { user_id: "user_a", deleted_at: null, playback_nonce: 0 };
    expect(playbackRowAllows(row, "user_a", 0)).toBe(true);
    expect(playbackRowAllows({ ...row, playback_nonce: 1 }, "user_a", 0)).toBe(false);
    expect(playbackRowAllows({ ...row, deleted_at: later }, "user_a", 0)).toBe(false);
    expect(playbackRowAllows({ ...row, user_id: "user_b" }, "user_a", 0)).toBe(false);
    expect(playbackRowAllows(null, "user_a", 0)).toBe(false);
  });
});
