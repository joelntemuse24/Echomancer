import { describe, expect, it } from "vitest";
import { shouldPollJob } from "./poll-schedule";

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
