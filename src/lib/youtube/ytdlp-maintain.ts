/**
 * Keep yt-dlp current. The worker calls this on a timer; the install
 * script also installs a daily systemd unit so an idle box still updates.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compareYtDlpVersion,
  defaultRunner,
  readYtDlpVersion,
  readYoutubeFetchEnv,
  YTDLP_MIN_VERSION,
} from "@/lib/youtube/fetch-audio";

const INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function maybeUpdateYtDlp(opts?: { force?: boolean }): Promise<void> {
  const env = readYoutubeFetchEnv();
  const dir = process.env.ECHOMANCER_SCRATCH_DIR?.trim() || path.join(tmpdir(), "echomancer");
  await mkdir(dir, { recursive: true });
  const stampPath = path.join(dir, "ytdlp-updated-at");
  let last = 0;
  try {
    last = Number((await readFile(stampPath, "utf8")).trim());
  } catch {
    last = 0;
  }
  const version = await readYtDlpVersion(env.bin);
  const tooOld = !version || compareYtDlpVersion(version, env.minVersion || YTDLP_MIN_VERSION) < 0;
  if (!opts?.force && !tooOld && Date.now() - last < INTERVAL_MS) return;

  if (tooOld) {
    console.warn(
      `[ytdlp] ${version || "missing"} is older than minimum ${env.minVersion}; updating`
    );
  } else {
    console.info(`[ytdlp] daily update (current ${version})`);
  }

  const updated = await defaultRunner(env.bin, ["-U"], 120_000);
  if (updated.code !== 0) {
    await defaultRunner("python3", ["-m", "pip", "install", "-U", "yt-dlp"], 180_000);
  }
  if (process.env.YTDLP_UPDATE_POT !== "0") {
    await defaultRunner(
      "python3",
      ["-m", "pip", "install", "-U", "bgutil-ytdlp-pot-provider"],
      180_000
    );
  }
  await writeFile(stampPath, String(Date.now()));
  const after = await readYtDlpVersion(env.bin);
  console.info(`[ytdlp] version ${after || "unknown"}`);
}

let scheduled = false;

/** Fire once at startup, then every 24h. Failures are logged, not fatal. */
export function scheduleYtDlpUpdate(): void {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    void maybeUpdateYtDlp().catch((err) => {
      console.warn(
        "[ytdlp] update failed",
        err instanceof Error ? err.message : err
      );
    });
  };
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
}
