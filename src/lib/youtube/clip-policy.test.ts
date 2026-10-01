import { describe, expect, it } from "vitest";
import {
  clampClipLength,
  clipOverBudget,
  clipRetryable,
  judgeDownloadLine,
  proxyClipEmailAllowed,
  proxyUrlForAttempt,
  redactYtDlpArgs,
  ytDlpArgv,
} from "./clip-policy";

describe("clip policy", () => {
  it("clamps length to 10–40 seconds and defaults to 20", () => {
    expect(clampClipLength(undefined)).toBe(20);
    expect(clampClipLength(5)).toBe(10);
    expect(clampClipLength(40)).toBe(40);
    expect(clampClipLength(90)).toBe(40);
  });

  it("allows only the listed email", () => {
    const env = { YT_PROXY_CLIPS_EMAILS: "Joel@Example.com, other@x.com" } as NodeJS.ProcessEnv;
    expect(proxyClipEmailAllowed("joel@example.com", env)).toBe(true);
    expect(proxyClipEmailAllowed("nope@example.com", env)).toBe(false);
  });

  it("trips each daily cap", () => {
    expect(clipOverBudget({ userCount: 15, appCount: 1, userBytes: 0, appBytes: 0 })).toBe(true);
    expect(clipOverBudget({ userCount: 1, appCount: 200, userBytes: 0, appBytes: 0 })).toBe(true);
    expect(clipOverBudget({ userCount: 1, appCount: 1, userBytes: 40 * 1024 * 1024, appBytes: 0 })).toBe(true);
    expect(clipOverBudget({ userCount: 1, appCount: 1, userBytes: 0, appBytes: 1024 ** 3 })).toBe(true);
    expect(clipOverBudget({ userCount: 14, appCount: 10, userBytes: 1000, appBytes: 1000 })).toBe(false);
  });

  it("rewrites the proxy session only on the second attempt", () => {
    const first = "http://user:secret@proxy.example:8000";
    expect(proxyUrlForAttempt(first, 1, "abcd1234")).toBe(first);
    const second = proxyUrlForAttempt(first, 2, "abcd1234");
    expect(second).toContain("session-abcd1234");
    expect(second).not.toContain("secret-session");
    expect(second).toContain("secret");
    const swapped = proxyUrlForAttempt(
      "http://user-session-old:secret@proxy.example:8000",
      2,
      "new1"
    );
    expect(swapped).toContain("session-new1");
    expect(swapped).not.toContain("session-old");
  });

  it("builds a section-only yt-dlp command and redacts the proxy", () => {
    const args = ytDlpArgv({
      proxyUrl: "http://user:secret@proxy.example:8000",
      pageUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      startSec: 12,
      endSec: 32,
      outputPath: "/tmp/audio.%(ext)s",
    });
    expect(args).toContain("--download-sections");
    expect(args).toContain("*12-32");
    expect(args).toContain("ba[ext=m4a]/ba");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--no-write-subs");
    expect(args).toContain("--socket-timeout");
    expect(args).not.toContain("--cookies");
    const redacted = redactYtDlpArgs(args);
    expect(redacted.join(" ")).not.toContain("secret");
    expect(redacted).toContain("[proxy]");
  });

  it("stops a full-file fallback and an 8 MB transfer", () => {
    expect(judgeDownloadLine("[download] The server does not support range requests", 10).stop).toBe(
      "range_unsupported"
    );
    const big = judgeDownloadLine("[download] 100% of 9.00MiB", 0);
    expect(big.stop).toBe("too_big");
    expect(big.bytes).toBeGreaterThan(8 * 1024 * 1024);
    const small = judgeDownloadLine("[download] 50% of 1.00MiB", 0);
    expect(small.stop).toBeUndefined();
    expect(small.bytes).toBe(Math.round(0.5 * 1024 * 1024));
  });

  it("retries a timeout once and not a range failure", () => {
    expect(clipRetryable("timeout", 1)).toBe(true);
    expect(clipRetryable("timeout", 2)).toBe(false);
    expect(clipRetryable("range_unsupported", 1)).toBe(false);
  });
});
