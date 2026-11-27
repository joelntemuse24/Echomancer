import { describe, expect, it } from "vitest";
import {
  growingFileDuration,
  seekPastLoadedFile,
  shouldRefreshGrowingFile,
} from "@/lib/player/growing-file";

describe("growing joined file", () => {
  it("shows the longer of the element and the joined length", () => {
    expect(growingFileDuration(20, 65)).toBe(65);
    expect(growingFileDuration(65, 20)).toBe(65);
    expect(growingFileDuration(0, null)).toBe(0);
  });

  it("reloads only once the playhead reaches the loaded end of a growing file", () => {
    expect(
      shouldRefreshGrowingFile({
        complete: false,
        elementDuration: 40,
        currentTime: 10,
        reportedSeconds: 80,
      })
    ).toBe(false);
    expect(
      shouldRefreshGrowingFile({
        complete: false,
        elementDuration: 40,
        currentTime: 39,
        reportedSeconds: 80,
      })
    ).toBe(true);
    expect(
      shouldRefreshGrowingFile({
        complete: true,
        elementDuration: 40,
        currentTime: 39,
        reportedSeconds: 80,
      })
    ).toBe(false);
  });

  it("treats a seek past the loaded end as a reload inside the joined length", () => {
    expect(
      seekPastLoadedFile({ elementDuration: 40, targetSeconds: 55, reportedSeconds: 80 })
    ).toBe(true);
    expect(
      seekPastLoadedFile({ elementDuration: 40, targetSeconds: 20, reportedSeconds: 80 })
    ).toBe(false);
    expect(
      seekPastLoadedFile({ elementDuration: 40, targetSeconds: 90, reportedSeconds: 80 })
    ).toBe(false);
  });
});
