import { describe, expect, it, vi } from "vitest";
import {
  resumeAudioGraphs,
  trackAudioContext,
  trackedAudioGraphCount,
} from "./audio-graph";

describe("tracked audio graphs", () => {
  it("resumes a suspended context and leaves a running one alone", async () => {
    const suspended = {
      state: "suspended",
      resume: vi.fn(async () => {}),
    };
    const running = {
      state: "running",
      resume: vi.fn(async () => {}),
    };
    const stopSuspended = trackAudioContext(suspended);
    const stopRunning = trackAudioContext(running);
    try {
      expect(trackedAudioGraphCount()).toBeGreaterThanOrEqual(2);
      expect(await resumeAudioGraphs()).toBe(true);
      expect(suspended.resume).toHaveBeenCalledTimes(1);
      expect(running.resume).not.toHaveBeenCalled();
      // Nothing is suspended any more, so a second call is a no-op.
      suspended.state = "running";
      expect(await resumeAudioGraphs()).toBe(false);
    } finally {
      stopSuspended();
      stopRunning();
    }
  });

  it("survives a context that refuses to resume or has no resume", async () => {
    const refuses = {
      state: "suspended",
      resume: async () => {
        throw new Error("not allowed");
      },
    };
    const bare = { state: "suspended" };
    const stopA = trackAudioContext(refuses);
    const stopB = trackAudioContext(bare);
    try {
      await expect(resumeAudioGraphs()).resolves.toBe(false);
    } finally {
      stopA();
      stopB();
    }
  });

  it("stops tracking when the owner is done with the context", () => {
    const before = trackedAudioGraphCount();
    const stop = trackAudioContext({ state: "running" });
    expect(trackedAudioGraphCount()).toBe(before + 1);
    stop();
    expect(trackedAudioGraphCount()).toBe(before);
  });
});
