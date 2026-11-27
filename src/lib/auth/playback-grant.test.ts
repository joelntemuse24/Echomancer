import { describe, expect, it } from "vitest";
import {
  clearPlaybackAuthCache,
  playbackAuthFresh,
  playbackGrantAllows,
  rememberPlaybackAuth,
  signPlaybackGrant,
} from "@/lib/auth/playback-grant";

describe("playback grant", () => {
  it("allows the signed folder for that session until it expires", () => {
    const now = 1_700_000_000_000;
    const token = signPlaybackGrant("user_a", "audiobooks/job1", now);
    expect(playbackGrantAllows("user_a", "audiobooks/job1/sections/0001.mp3", token, now)).toBe(
      true
    );
    expect(playbackGrantAllows("user_a", "audiobooks/job1/full.mp3", token, now)).toBe(true);
    expect(playbackGrantAllows("user_b", "audiobooks/job1/full.mp3", token, now)).toBe(false);
    expect(playbackGrantAllows("user_a", "audiobooks/other/full.mp3", token, now)).toBe(false);
    expect(playbackGrantAllows("user_a", "audiobooks/job1/full.mp3", token, now + 10 * 60_000)).toBe(
      false
    );
    expect(signPlaybackGrant("user_a", "audiobooks/job1", now + 1000)).toBe(token);
  });
});

describe("playback auth cache", () => {
  it("remembers an ownership answer for one folder and then drops it", () => {
    clearPlaybackAuthCache();
    const now = 1_000;
    expect(playbackAuthFresh("user_a", "audiobooks/job1/sections/0000.mp3", now)).toBe(false);
    rememberPlaybackAuth("user_a", "audiobooks/job1/sections/0000.mp3", now);
    expect(playbackAuthFresh("user_a", "audiobooks/job1/full.mp3", now + 1000)).toBe(true);
    expect(playbackAuthFresh("user_a", "audiobooks/job2/full.mp3", now + 1000)).toBe(false);
    expect(playbackAuthFresh("user_b", "audiobooks/job1/full.mp3", now + 1000)).toBe(false);
    expect(playbackAuthFresh("user_a", "audiobooks/job1/full.mp3", now + 61_000)).toBe(false);
  });
});
