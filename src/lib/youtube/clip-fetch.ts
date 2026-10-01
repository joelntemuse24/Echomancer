/**
 * Download one time range with yt-dlp. The proxy URL is an argument to the
 * process and is never written to a log line.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalYoutubeUrl } from "@/lib/youtube/range";
import {
  CLIP_WALL_MS,
  judgeDownloadLine,
  proxyUrlForAttempt,
  redactYtDlpArgs,
  ytDlpArgv,
  type ClipErrorCode,
} from "@/lib/youtube/clip-policy";

export type SectionDownload =
  | { ok: true; file: string; bytes: number }
  | { ok: false; code: ClipErrorCode; bytes: number };

function killProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (pid && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* not a process group */
    }
  }
  child.kill("SIGKILL");
}

export async function downloadYoutubeSection(opts: {
  proxyUrl: string;
  videoId: string;
  startSec: number;
  endSec: number;
  cwd: string;
  attempt: number;
  sessionId: string;
  spawnImpl?: typeof spawn;
}): Promise<SectionDownload> {
  const proxy = proxyUrlForAttempt(opts.proxyUrl, opts.attempt, opts.sessionId);
  const outputPath = path.join(opts.cwd, "audio.%(ext)s");
  const args = ytDlpArgv({
    proxyUrl: proxy,
    pageUrl: canonicalYoutubeUrl(opts.videoId),
    startSec: opts.startSec,
    endSec: opts.endSec,
    outputPath,
  });
  console.info(`[yt-clip] yt-dlp ${redactYtDlpArgs(args).join(" ")}`);

  const spawnImpl = opts.spawnImpl ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnImpl(process.env.YT_DLP_BIN?.trim() || "yt-dlp", args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { ok: false, code: "unavailable", bytes: 0 };
  }

  let bytes = 0;
  let stop: "too_big" | "range_unsupported" | "timeout" | null = null;
  const take = (chunk: Buffer | string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const judged = judgeDownloadLine(line, bytes);
      bytes = judged.bytes;
      if (judged.stop && !stop) {
        stop = judged.stop;
        killProcess(child);
      }
    }
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const timer = setTimeout(() => {
    if (!stop) stop = "timeout";
    killProcess(child);
  }, CLIP_WALL_MS);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
  clearTimeout(timer);

  if (stop === "range_unsupported" || stop === "too_big" || stop === "timeout") {
    return { ok: false, code: stop, bytes };
  }
  if (exitCode !== 0) return { ok: false, code: "unavailable", bytes };

  const names = await readdir(opts.cwd).catch(() => [] as string[]);
  const audio = names.find((name) => /\.(m4a|webm|opus|mp4|ogg)$/i.test(name));
  if (!audio) return { ok: false, code: "range_unsupported", bytes };
  return { ok: true, file: path.join(opts.cwd, audio), bytes };
}
