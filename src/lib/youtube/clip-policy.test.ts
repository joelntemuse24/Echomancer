import { describe, expect, it } from "vitest";
import {
  apifyClipInput,
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

  it("asks Apify for best audio of a clock range and hides the token", () => {
    expect(formatClipTimeframe(30, 50)).toBe("0:30-0:50");
    const input = apifyClipInput("abcdefghijk", 30, 50);
    expect(input).toEqual({
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      audioQuality: "best",
      timeframe: "0:30-0:50",
    });
    expect(input).not.toHaveProperty("proxyConfiguration");
    expect(scrubToken("bad token secret-token here", "secret-token")).toBe("bad token [token] here");
  });

  it("retries a timeout once and not a range failure", () => {
    expect(clipRetryable("timeout", 1)).toBe(true);
    expect(clipRetryable("timeout", 2)).toBe(false);
    expect(clipRetryable("range_unsupported", 1)).toBe(false);
  });
});
