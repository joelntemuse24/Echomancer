import { describe, expect, it } from "vitest";
import {
  JOB_POLL_MAX_MS,
  JOB_POLL_MIN_MS,
  nextJobPollDelay,
  shouldPollJob,
} from "./poll-schedule";

describe("shouldPollJob", () => {
  it("polls a visible tab", () => {
    expect(
      shouldPollJob({ visibility: "visible", playing: false, waitingForNext: false })
    ).toBe(true);
  });

  it("skips a hidden tab that is not playing", () => {
    expect(
      shouldPollJob({ visibility: "hidden", playing: false, waitingForNext: false })
    ).toBe(false);
  });

  it("keeps polling a hidden tab that is playing or waiting on the next section", () => {
    expect(
      shouldPollJob({ visibility: "hidden", playing: true, waitingForNext: false })
    ).toBe(true);
    expect(
      shouldPollJob({ visibility: "hidden", playing: false, waitingForNext: true })
    ).toBe(true);
  });
});

describe("nextJobPollDelay", () => {
  it("uses a two second first interval", () => {
    expect(JOB_POLL_MIN_MS).toBe(2_000);
  });

  it("stays at the minimum until audio is playable, however long it waits", () => {
    let delay = JOB_POLL_MIN_MS;
    for (let i = 0; i < 6; i++) {
      delay = nextJobPollDelay({ delay, changed: false, hasPlayableAudio: false });
      expect(delay).toBe(JOB_POLL_MIN_MS);
    }
  });

  it("backs off once audio is playable and nothing changes", () => {
    expect(
      nextJobPollDelay({ delay: JOB_POLL_MIN_MS, changed: false, hasPlayableAudio: true })
    ).toBe(3_000);
    expect(
      nextJobPollDelay({ delay: 3_000, changed: false, hasPlayableAudio: true })
    ).toBe(4_500);
  });

  it("snaps back to the minimum on any change", () => {
    expect(
      nextJobPollDelay({ delay: 13_500, changed: true, hasPlayableAudio: true })
    ).toBe(JOB_POLL_MIN_MS);
    expect(
      nextJobPollDelay({ delay: 13_500, changed: true, hasPlayableAudio: false })
    ).toBe(JOB_POLL_MIN_MS);
  });

  it("never exceeds the cap", () => {
    expect(
      nextJobPollDelay({ delay: JOB_POLL_MAX_MS, changed: false, hasPlayableAudio: true })
    ).toBe(JOB_POLL_MAX_MS);
  });
});
