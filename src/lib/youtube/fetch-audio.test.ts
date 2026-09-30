import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareYtDlpVersion,
  downloadYoutubeSection,
  planFetchStrategies,
  resetPotProbe,
  ytdlpSectionArgs,
  YTDLP_MIN_VERSION,
  type CommandResult,
  type YoutubeFetchEnv,
} from "./fetch-audio";

const env: YoutubeFetchEnv = {
  bin: "yt-dlp",
  minVersion: YTDLP_MIN_VERSION,
  potBaseUrl: "http://127.0.0.1:4416",
  potServerHome: "",
  cookiesFile: "/tmp/cookies.txt",
  proxy: "http://user:secret@proxy.example:8080",
};

describe("yt-dlp section download", () => {
  afterEach(() => {
    resetPotProbe();
  });

  it("orders PO token, then cookies, then proxy, then a direct attempt", () => {
    expect(
      planFetchStrategies({ pot: true, cookies: true, proxy: true }).map((s) => s.name)
    ).toEqual(["pot", "cookies", "proxy", "direct"]);
    expect(planFetchStrategies({ pot: false, cookies: false, proxy: false }).map((s) => s.name)).toEqual([
      "direct",
    ]);
  });

  it("asks yt-dlp for bestaudio of the section only", () => {
    const args = ytdlpSectionArgs({
      env,
      strategy: { name: "pot+cookies+proxy", pot: true, cookies: true, proxy: true },
      videoId: "abcdefghijk",
      startSec: 12,
      endSec: 42,
      outputTemplate: "/tmp/section.%(ext)s",
    });
    expect(args).toContain("--download-sections");
    expect(args).toContain("*12-42");
    expect(args).toContain("bestaudio");
    expect(args).toContain("--downloader");
    expect(args).toContain("ffmpeg");
    expect(args).toContain("--cookies");
    expect(args).toContain(env.cookiesFile);
    expect(args).toContain("--proxy");
    expect(args).toContain(env.proxy);
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(args.join(" ")).not.toContain("bestvideo");
  });

  it("tries cookies and the proxy without a PO token or the web player client", () => {
    const cookies = ytdlpSectionArgs({
      env,
      strategy: { name: "cookies", pot: false, cookies: true, proxy: false },
      videoId: "abcdefghijk",
      startSec: 10,
      endSec: 40,
      outputTemplate: "/tmp/section.%(ext)s",
    });
    expect(cookies).toContain("--cookies");
    expect(cookies.join(" ")).not.toContain("player_client");
    expect(cookies.join(" ")).not.toContain("bgutil");
    expect(cookies).not.toContain("--proxy");

    const proxy = ytdlpSectionArgs({
      env,
      strategy: { name: "proxy", pot: false, cookies: false, proxy: true },
      videoId: "abcdefghijk",
      startSec: 10,
      endSec: 40,
      outputTemplate: "/tmp/section.%(ext)s",
    });
    expect(proxy).toContain("--proxy");
    expect(proxy).toContain(env.proxy);
    expect(proxy.join(" ")).not.toContain("player_client");
    expect(proxy.join(" ")).not.toContain("bgutil");
    expect(proxy).not.toContain("--cookies");
    expect(proxy).toContain("--max-filesize");
  });

  it("compares calendar versions against the minimum", () => {
    expect(compareYtDlpVersion("2025.10.14", YTDLP_MIN_VERSION)).toBe(0);
    expect(compareYtDlpVersion("2024.01.01", YTDLP_MIN_VERSION)).toBeLessThan(0);
    expect(compareYtDlpVersion("2026.09.01", YTDLP_MIN_VERSION)).toBeGreaterThan(0);
  });

  it("retries with backoff, then uses the next strategy", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yt-fetch-"));
    const sleeps: number[] = [];
    const names: string[] = [];
    let calls = 0;
    const run = async (_bin: string, args: string[]): Promise<CommandResult> => {
      calls += 1;
      const strategy = args.includes("--proxy")
        ? "proxy"
        : args.includes("--cookies")
          ? "cookies"
          : args.some((arg) => arg.includes("bgutil"))
            ? "pot"
            : "direct";
      names.push(strategy);
      if (strategy !== "direct") {
        return { code: 1, stdout: "", stderr: `fail ${env.proxy}`, timedOut: false };
      }
      await writeFile(path.join(dir, "section.m4a"), Buffer.from("audio"));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };

    const logs: string[] = [];
    const result = await downloadYoutubeSection({
      videoId: "abcdefghijk",
      startSec: 10,
      endSec: 40,
      workDir: dir,
      env,
      run,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      resolveFlags: async () => ({ pot: true, cookies: true, proxy: true }),
      fileSize: async () => 1000,
      probeDuration: async () => 30,
      log: (line) => logs.push(line),
    });

    expect(result.strategy).toBe("direct");
    expect(result.attempts).toBe(4);
    expect(names.filter((name) => name === "pot")).toHaveLength(1);
    expect(names).toEqual(["pot", "cookies", "proxy", "direct"]);
    expect(sleeps.length).toBe(0);
    expect(logs.some((line) => line.includes("strategy=direct") && line.includes("ok=true"))).toBe(
      true
    );
    expect(logs.join("\n")).not.toContain("secret");
    expect(calls).toBe(4);
  });

  it("refuses a file that is longer than the selected range", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yt-oversize-"));
    await mkdir(dir, { recursive: true });
    let calls = 0;
    const result = await downloadYoutubeSection({
      videoId: "abcdefghijk",
      startSec: 0,
      endSec: 30,
      workDir: dir,
      env: { ...env, potBaseUrl: "", cookiesFile: "", proxy: "" },
      resolveFlags: async () => ({ pot: false, cookies: false, proxy: false }),
      sleep: async () => {},
      fileSize: async () => 1000,
      probeDuration: async () => (calls < 2 ? 600 : 30),
      run: async () => {
        calls += 1;
        await writeFile(path.join(dir, "section.m4a"), Buffer.from("audio"));
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(result.strategy).toBe("direct");
    expect(calls).toBe(2);
  });
});
