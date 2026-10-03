import { describe, expect, it } from "vitest";
import {
  apifyClipInput,
  apifyFailureCode,
  apifyLinkFloorUsd,
  apifyLogSignal,
  apifySegmentClipInput,
  apifySegmentFloorUsd,
  apifyUsdFromRun,
  apifyWaitSeconds,
  appDailyApifyUsd,
  clampClipLength,
  CLIP_LONG_SOURCE_SEC,
  clipActorOrder,
  clipAttemptWallMs,
  clipFallbackable,
  clipOverBudget,
  clipRetryable,
  clipSegmentSourceSec,
  formatClipTimeframe,
  proxyClipEmailAllowed,
  scrubToken,
} from "./clip-policy";

describe("clip policy", () => {
  it("clamps length to 10–40 seconds and defaults to 20", () => {
    expect(clampClipLength(undefined)).toBe(20);
    expect(clampClipLength(5)).toBe(10);
    expect(clampClipLength(40)).toBe(40);
    expect(clampClipLength(90)).toBe(40);
  });

  it("allows only the listed email", () => {
    const env = { YT_SERVER_CLIPS_EMAILS: "Joel@Example.com, other@x.com" } as NodeJS.ProcessEnv;
    expect(proxyClipEmailAllowed("joel@example.com", env)).toBe(true);
    expect(proxyClipEmailAllowed("nope@example.com", env)).toBe(false);
  });

  it("trips each daily cap", () => {
    expect(clipOverBudget({ userCount: 15, appCount: 1, userBytes: 0, appBytes: 0 })).toBe(true);
    expect(clipOverBudget({ userCount: 1, appCount: 200, userBytes: 0, appBytes: 0 })).toBe(true);
    expect(clipOverBudget({ userCount: 1, appCount: 1, userBytes: 128 * 1024 * 1024, appBytes: 0 })).toBe(true);
    expect(clipOverBudget({ userCount: 1, appCount: 1, userBytes: 0, appBytes: 2 * 1024 ** 3 })).toBe(true);
    expect(clipOverBudget({ userCount: 14, appCount: 10, userBytes: 1000, appBytes: 1000, appUsd: 1.9, usdLimit: 2 })).toBe(false);
    expect(clipOverBudget({ userCount: 1, appCount: 1, userBytes: 0, appBytes: 0, appUsd: 2, usdLimit: 2 })).toBe(true);
    expect(appDailyApifyUsd({} as NodeJS.ProcessEnv)).toBe(2);
  });

  it("long-polls for at most 60 seconds and skips a wait that would outlast the wall", () => {
    expect(apifyWaitSeconds(90_000)).toBe(60);
    expect(apifyWaitSeconds(12_400)).toBe(12);
    expect(apifyWaitSeconds(1_000)).toBe(0);
  });

  it("asks Apify for best audio of a clock range and hides the token", () => {
    expect(formatClipTimeframe(30, 50)).toBe("0:30-0:50");
    const input = apifyClipInput("abcdefghijk", 30, 50);
    expect(input).toEqual({
      videos: [
        {
          url: "https://www.youtube.com/watch?v=abcdefghijk",
          timeframe: "0:30-0:50",
          audioQuality: "best",
        },
      ],
    });
    expect(input).not.toHaveProperty("proxyConfiguration");
    expect(scrubToken("bad token secret-token here", "secret-token")).toBe("bad token [token] here");
  });

  it("prices a settled total, or the actor events when that total is still zero", () => {
    expect(
      apifyUsdFromRun({
        usageTotalUsd: 0,
        chargedEventCounts: { AUDIO_DOWNLOADED: 1, AUDIO_LONG_EXTRA: 5 },
      })
    ).toBeCloseTo(0.035);
    expect(
      apifyUsdFromRun({
        usageTotalUsd: 0.04,
        chargedEventCounts: { AUDIO_DOWNLOADED: 1 },
      })
    ).toBeCloseTo(0.04);
    expect(apifyUsdFromRun({ usageTotalUsd: 0 })).toBe(0);
  });

  it("prices the segment actor events and its floor", () => {
    expect(
      apifyUsdFromRun({
        usageTotalUsd: 0,
        chargedEventCounts: {
          "video-started": 1,
          "audio-minute-processed": 1,
          "apify-actor-start": 1,
        },
      })
    ).toBeCloseTo(0.0901);
    expect(apifyUsdFromRun({ usageTotalUsd: 0, chargedEventCounts: { "apify-actor-start": 1 } })).toBeCloseTo(
      0.00005
    );
    expect(apifySegmentFloorUsd(20)).toBeCloseTo(0.09);
    expect(apifySegmentFloorUsd(60)).toBeCloseTo(0.09);
    expect(apifySegmentFloorUsd(61)).toBeCloseTo(0.13);
    // Link floor is $0.015 plus $0.004 per started 10-minute block of the source.
    expect(apifyLinkFloorUsd(undefined)).toBeCloseTo(0.015);
    expect(apifyLinkFloorUsd(213)).toBeCloseTo(0.019);
    expect(apifyLinkFloorUsd(600)).toBeCloseTo(0.019);
    expect(apifyLinkFloorUsd(3000)).toBeCloseTo(0.035);
    expect(apifyLinkFloorUsd(3600)).toBeCloseTo(0.039);
  });

  it("picks the segment actor at 30 minutes of source, with an env override", () => {
    expect(clipActorOrder(2738)).toEqual(["segment", "link"]);
    expect(clipActorOrder(1800)).toEqual(["segment", "link"]);
    expect(clipActorOrder(1799)).toEqual(["link", "segment"]);
    expect(clipActorOrder(598)).toEqual(["link", "segment"]);
    expect(clipActorOrder(null)).toEqual(["link", "segment"]);
    expect(clipActorOrder(undefined)).toEqual(["link", "segment"]);
    expect(clipActorOrder(900, { CLIP_SEGMENT_SOURCE_SEC: "600" } as NodeJS.ProcessEnv)).toEqual([
      "segment",
      "link",
    ]);
    expect(clipSegmentSourceSec({} as NodeJS.ProcessEnv)).toBe(CLIP_LONG_SOURCE_SEC);
    expect(CLIP_LONG_SOURCE_SEC).toBe(1800);
  });

  it("gives the link actor a longer wall on a long source", () => {
    expect(clipAttemptWallMs("segment", 2738)).toBe(90_000);
    expect(clipAttemptWallMs("segment", null)).toBe(90_000);
    expect(clipAttemptWallMs("link", 600)).toBe(90_000);
    expect(clipAttemptWallMs("link", 2738)).toBe(180_000);
    expect(clipAttemptWallMs("link", null)).toBe(90_000);
  });

  it("falls back on actor-specific failures but not on a budget stop", () => {
    expect(clipFallbackable("restricted")).toBe(true);
    expect(clipFallbackable("transient")).toBe(true);
    expect(clipFallbackable("timeout")).toBe(true);
    expect(clipFallbackable("range_unsupported")).toBe(true);
    expect(clipFallbackable("too_big")).toBe(true);
    expect(clipFallbackable("unavailable")).toBe(false);
    expect(clipFallbackable("budget")).toBe(false);
    expect(clipFallbackable("unusable_audio")).toBe(false);
  });

  it("builds the segment actor input with string seconds and no transcript", () => {
    expect(apifySegmentClipInput("abcdefghijk", 300, 320)).toEqual({
      videos: ["https://www.youtube.com/watch?v=abcdefghijk"],
      format: "wav",
      startTime: "300",
      endTime: "320",
      transcribe: false,
    });
  });

  it("maps blocked and missing videos, and does not retry a timeout", () => {
    expect(apifyFailureCode("no usable connections after scan")).toBe("restricted");
    expect(apifyFailureCode("Video not found")).toBe("unavailable");
    expect(apifyFailureCode("Sign in to confirm your age")).toBe("unavailable");
    expect(apifyFailureCode("Sign in to confirm you're not a bot")).toBe("restricted");
    expect(apifyFailureCode("sign-in required")).toBe("unavailable");
    expect(apifyFailureCode("not made available in your country")).toBe("unavailable");
    expect(apifyFailureCode("audio-download-failed")).toBe("transient");
    expect(apifyFailureCode('RESULTS_JSON {"error":"sabr-gapped"}')).toBe("transient");
    expect(clipRetryable("unavailable", 1)).toBe(false);
    expect(clipRetryable("transient", 1)).toBe(true);
    expect(clipRetryable("transient", 2)).toBe(false);
    expect(clipRetryable("restricted", 1)).toBe(false);
    expect(clipRetryable("timeout", 1)).toBe(false);
    expect(clipRetryable("range_unsupported", 1)).toBe(false);
    const log = `${"noise\n".repeat(20)}ACTOR_ERROR no usable connections after scan\n`;
    expect(apifyLogSignal(log)).toContain("no usable connections after scan");
    expect(apifyFailureCode(apifyLogSignal(log))).toBe("restricted");
    expect(apifyLogSignal("plain tail sabr-gapped")).toContain("sabr-gapped");
  });
});
