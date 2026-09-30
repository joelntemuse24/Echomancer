/**
 * Download only the selected YouTube range with yt-dlp.
 *
 * YouTube blocks datacenter IPs, so each clip falls through:
 * PO token (bgutil) → cookies → residential proxy, with one retry
 * and backoff on each strategy. The command is audio-only
 * `--download-sections` and is rejected if the file is a whole video.
 */

import { spawn } from "node:child_process";
import { access, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  canonicalYoutubeUrl,
  downloadSectionSpec,
  isYoutubeVideoId,
  sectionByteCap,
} from "@/lib/youtube/range";

/** Floor. bgutil needs >= 2025.05.22. Daily update pulls newer builds. */
export const YTDLP_MIN_VERSION = "2025.10.14";

export type FetchStrategy = {
  name: string;
  pot: boolean;
  cookies: boolean;
  proxy: boolean;
};

export type YoutubeFetchEnv = {
  bin: string;
  minVersion: string;
  potBaseUrl: string;
  potServerHome: string;
  cookiesFile: string;
  proxy: string;
};

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CommandRunner = (
  bin: string,
  args: string[],
  timeoutMs: number
) => Promise<CommandResult>;

export function readYoutubeFetchEnv(
  env: NodeJS.ProcessEnv = process.env
): YoutubeFetchEnv {
  const potExplicit = env.YTDLP_POT_BASE_URL;
  return {
    bin: env.YTDLP_BIN?.trim() || "yt-dlp",
    minVersion: env.YTDLP_MIN_VERSION?.trim() || YTDLP_MIN_VERSION,
    potBaseUrl:
      potExplicit === undefined
        ? "http://127.0.0.1:4416"
        : potExplicit.trim(),
    potServerHome: env.YTDLP_POT_SERVER_HOME?.trim() || "",
    cookiesFile: env.YTDLP_COOKIES_FILE?.trim() || "",
    proxy: env.YTDLP_PROXY?.trim() || "",
  };
}

export function compareYtDlpVersion(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number(part) || 0);
  const pb = b.split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function planFetchStrategies(flags: {
  pot: boolean;
  cookies: boolean;
  proxy: boolean;
}): FetchStrategy[] {
  const list: FetchStrategy[] = [];
  const push = (strategy: FetchStrategy) => {
    if (
      list.some(
        (item) =>
          item.pot === strategy.pot &&
          item.cookies === strategy.cookies &&
          item.proxy === strategy.proxy
      )
    ) {
      return;
    }
    list.push(strategy);
  };

  if (flags.pot) {
    push({ name: "pot", pot: true, cookies: false, proxy: false });
  }
  if (flags.cookies) {
    push({
      name: flags.pot ? "pot+cookies" : "cookies",
      pot: flags.pot,
      cookies: true,
      proxy: false,
    });
  }
  if (flags.proxy) {
    const name = [
      flags.pot ? "pot" : "",
      flags.cookies ? "cookies" : "",
      "proxy",
    ]
      .filter(Boolean)
      .join("+");
    push({
      name,
      pot: flags.pot,
      cookies: flags.cookies,
      proxy: true,
    });
  }
  push({ name: "direct", pot: false, cookies: false, proxy: false });
  return list;
}

export function ytdlpSectionArgs(opts: {
  env: YoutubeFetchEnv;
  strategy: FetchStrategy;
  videoId: string;
  startSec: number;
  endSec: number;
  outputTemplate: string;
}): string[] {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--force-overwrites",
    "-f",
    "bestaudio",
    "--downloader",
    "ffmpeg",
    "--download-sections",
    downloadSectionSpec(opts.startSec, opts.endSec),
    "--force-keyframes-at-cuts",
    "-o",
    opts.outputTemplate,
  ];

  if (opts.strategy.pot && opts.env.potServerHome) {
    args.push(
      "--extractor-args",
      `youtubepot-bgutilscript:server_home=${opts.env.potServerHome}`
    );
  } else if (opts.strategy.pot && opts.env.potBaseUrl) {
    args.push(
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=${opts.env.potBaseUrl}`
    );
  }
  if (opts.strategy.pot) {
    args.push("--extractor-args", "youtube:player_client=default,web");
  }
  if (opts.strategy.cookies && opts.env.cookiesFile) {
    args.push("--cookies", opts.env.cookiesFile);
  }
  if (opts.strategy.proxy && opts.env.proxy) {
    args.push("--proxy", opts.env.proxy);
  }
  args.push(canonicalYoutubeUrl(opts.videoId));
  return args;
}

const ATTEMPTS_PER_STRATEGY = 2;
const BACKOFF_MS = 700;
const ATTEMPT_TIMEOUT_MS = 12_000;

export class YoutubeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeFetchError";
  }
}

export async function downloadYoutubeSection(opts: {
  videoId: string;
  startSec: number;
  endSec: number;
  workDir: string;
  env?: YoutubeFetchEnv;
  run?: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deadlineAt?: number;
  log?: (line: string) => void;
  resolveFlags?: (env: YoutubeFetchEnv) => Promise<{
    pot: boolean;
    cookies: boolean;
    proxy: boolean;
  }>;
  fileSize?: (filePath: string) => Promise<number>;
  probeDuration?: (filePath: string) => Promise<number | null>;
}): Promise<{ strategy: string; filePath: string; attempts: number }> {
  if (!isYoutubeVideoId(opts.videoId)) {
    throw new YoutubeFetchError("That link is not a YouTube video.");
  }
  const env = opts.env ?? readYoutubeFetchEnv();
  const run = opts.run ?? defaultRunner;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line) => console.info(line));
  const flags = opts.resolveFlags
    ? { ...(await opts.resolveFlags(env)), env }
    : await resolveStrategyFlags(env);
  const activeEnv = flags.env;
  const strategies = planFetchStrategies(flags);
  const outputTemplate = path.join(opts.workDir, "section.%(ext)s");
  const expected = opts.endSec - opts.startSec;
  const cap = sectionByteCap(expected);
  let attempts = 0;
  let lastReason = "no strategy";

  for (const strategy of strategies) {
    for (let tryIndex = 0; tryIndex < ATTEMPTS_PER_STRATEGY; tryIndex++) {
      if (opts.deadlineAt != null && now() >= opts.deadlineAt) {
        throw new YoutubeFetchError("Timed out before a clip could be downloaded.");
      }
      if (tryIndex > 0) await sleep(BACKOFF_MS * 2 ** (tryIndex - 1));
      attempts += 1;
      const started = now();
      await clearSectionFiles(opts.workDir);
      const args = ytdlpSectionArgs({
        env: activeEnv,
        strategy,
        videoId: opts.videoId,
        startSec: opts.startSec,
        endSec: opts.endSec,
        outputTemplate,
      });
      const result = await run(env.bin, args, ATTEMPT_TIMEOUT_MS);
      const elapsed = now() - started;
      if (result.code !== 0 || result.timedOut) {
        lastReason = result.timedOut ? "timeout" : `exit ${result.code ?? "?"}`;
        log(
          `[youtube-clip] video=${opts.videoId} strategy=${strategy.name} ok=false ms=${elapsed} reason=${lastReason} ${redact(result.stderr, env)}`
        );
        continue;
      }

      const filePath = await findSectionFile(opts.workDir);
      if (!filePath) {
        lastReason = "no output";
        log(
          `[youtube-clip] video=${opts.videoId} strategy=${strategy.name} ok=false ms=${elapsed} reason=no-output`
        );
        continue;
      }

      const size = opts.fileSize
        ? await opts.fileSize(filePath)
        : (await stat(filePath)).size;
      if (size > cap) {
        lastReason = "oversize";
        await unlink(filePath).catch(() => {});
        log(
          `[youtube-clip] video=${opts.videoId} strategy=${strategy.name} ok=false ms=${elapsed} reason=oversize bytes=${size}`
        );
        continue;
      }

      const duration = opts.probeDuration
        ? await opts.probeDuration(filePath)
        : await probeMediaDuration(filePath);
      if (duration != null && duration > expected + 8) {
        lastReason = "full-video";
        await unlink(filePath).catch(() => {});
        log(
          `[youtube-clip] video=${opts.videoId} strategy=${strategy.name} ok=false ms=${elapsed} reason=full-video duration=${duration.toFixed(1)}`
        );
        continue;
      }

      log(
        `[youtube-clip] video=${opts.videoId} strategy=${strategy.name} ok=true ms=${elapsed} bytes=${size}`
      );
      return { strategy: strategy.name, filePath, attempts };
    }
  }

  throw new YoutubeFetchError(lastReason);
}

async function resolveStrategyFlags(env: YoutubeFetchEnv): Promise<{
  pot: boolean;
  cookies: boolean;
  proxy: boolean;
  env: YoutubeFetchEnv;
}> {
  const cookies = env.cookiesFile ? await fileExists(env.cookiesFile) : false;
  const scriptHome = env.potServerHome || defaultPotServerHome();
  const scriptReady = await fileExists(path.join(scriptHome, "package.json"));
  const httpReady = env.potBaseUrl ? await potServerReachable(env.potBaseUrl) : false;
  const resolved: YoutubeFetchEnv = { ...env };
  if (httpReady) {
    resolved.potServerHome = "";
  } else if (scriptReady) {
    resolved.potServerHome = scriptHome;
  }
  return {
    pot: httpReady || scriptReady,
    cookies,
    proxy: Boolean(env.proxy),
    env: resolved,
  };
}

function defaultPotServerHome(): string {
  return path.join(homedir(), "bgutil-ytdlp-pot-provider", "server");
}

let potProbe: { url: string; at: number; ok: boolean } | null = null;

export async function potServerReachable(url: string): Promise<boolean> {
  if (potProbe && potProbe.url === url && Date.now() - potProbe.at < 60_000) {
    return potProbe.ok;
  }
  let ok = false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(400) });
    ok = response.status < 500;
  } catch {
    ok = false;
  }
  potProbe = { url, at: Date.now(), ok };
  return ok;
}

export function resetPotProbe(): void {
  potProbe = null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function clearSectionFiles(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name.startsWith("section."))
      .map((name) => unlink(path.join(dir, name)).catch(() => {}))
  );
}

async function findSectionFile(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => []);
  const match = names.find((name) => name.startsWith("section.") && !name.endsWith(".part"));
  return match ? path.join(dir, match) : null;
}

export function defaultRunner(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({
        code: 127,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = tail(stdout + String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = tail(stderr + String(chunk));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: 127, stdout, stderr: err.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

function tail(text: string): string {
  return text.length > 4_000 ? text.slice(-4_000) : text;
}

function redact(text: string, env: YoutubeFetchEnv): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (const secret of [env.proxy, env.cookiesFile, env.potServerHome]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 240);
}

export async function probeMediaDuration(filePath: string): Promise<number | null> {
  const bin = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  const result = await defaultRunner(
    bin,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ],
    8_000
  );
  if (result.code !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

export async function readYtDlpVersion(bin = readYoutubeFetchEnv().bin): Promise<string | null> {
  const result = await defaultRunner(bin, ["--version"], 8_000);
  if (result.code !== 0) return null;
  const version = result.stdout.trim().split(/\s+/)[0] || "";
  return /^\d{4}\.\d{2}\.\d{2}/.test(version) ? version : null;
}
