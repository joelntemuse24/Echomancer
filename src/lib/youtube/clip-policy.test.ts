import { describe, expect, it } from "vitest";
import {
  apifyClipInput,
  apifyFailureCode,
  apifyLogSignal,
  apifyUsdFromRun,
  apifyWaitSeconds,
  appDailyApifyUsd,
  clampClipLength,
  clipOverBudget,
  clipRetryable,
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
    expect(clipOverBudget({ userCount: 1, appCount: 1, userBytes: 40 * 1024 * 1024, appBytes: 0 })).toBe(true);
    expect(clipOverBudget({ userCount: 1, appCount: 1, userBytes: 0, appBytes: 1024 ** 3 })).toBe(true);
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

  it("maps blocked and missing videos, and does not retry a timeout", () => {
    expect(apifyFailureCode("no usable connections after scan")).toBe("restricted");
    expect(apifyFailureCode("Video not found")).toBe("unavailable");
    expect(apifyFailureCode("Sign in to confirm your age")).toBe("restricted");
    expect(apifyFailureCode("sign-in required")).toBe("restricted");
    expect(apifyFailureCode("not made available in your country")).toBe("restricted");
    expect(apifyFailureCode("audio-download-failed")).toBe("transient");
    expect(apifyFailureCode('RESULTS_JSON {"error":"sabr-gapped"}')).toBe("transient");
    expect(clipRetryable("unavailable", 1)).toBe(true);
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
