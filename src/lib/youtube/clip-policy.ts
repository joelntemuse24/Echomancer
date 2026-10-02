/**
 * Rules for a server-side YouTube section. Pure helpers. The Apify token
 * never appears in these strings.
 */

import { canonicalYoutubeUrl } from "@/lib/youtube/range";

export const CLIP_MIN_SEC = 10;
export const CLIP_MAX_SEC = 40;
export const CLIP_DEFAULT_SEC = 20;
export const CLIP_PROXY_BYTE_CAP = 8 * 1024 * 1024;
export const CLIP_USER_DAY_COUNT = 15;
export const CLIP_APP_DAY_COUNT = 200;
export const CLIP_USER_DAY_BYTES = 40 * 1024 * 1024;
export const CLIP_APP_DAY_BYTES = 1024 * 1024 * 1024;
export const CLIP_ATTEMPTS = 2;
/** A 50-minute lecture took 77s. Short videos finish in 24–37s. */
export const CLIP_WALL_MS = 90_000;
/** The runs API accepts at most 60 seconds of waitForFinish. */
export const APIFY_WAIT_SEC = 60;
/** Abort the actor once this run would cost about five cents. */
export const APIFY_MAX_RUN_USD = 0.05;
export const APIFY_RESULT_USD = 0.015;
export const APIFY_LENGTH_BLOCK_USD = 0.004;

export const CLIP_ERROR_CODES = [
  "unavailable",
  "range_unsupported",
  "too_big",
  "timeout",
  "unusable_audio",
  /** The reference gate warned. The pending upload stays, so the user can continue. */
  "risky_audio",
  "restricted",
  "budget",
  "transient",
] as const;

export type ClipErrorCode = (typeof CLIP_ERROR_CODES)[number];

/** One more try for a blip. A timeout or a blocked video is not started again. */
const RETRYABLE = new Set<ClipErrorCode>(["unavailable", "transient"]);

export function clampClipLength(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return CLIP_DEFAULT_SEC;
  return Math.min(CLIP_MAX_SEC, Math.max(CLIP_MIN_SEC, Math.round(raw)));
}

export function utcDayStartSec(now = Date.now()): number {
  const d = new Date(now);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/** Daily Apify spend for the whole app. Default $2. */
export function appDailyApifyUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.APP_DAILY_APIFY_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

export function proxyClipAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.YT_SERVER_CLIPS_EMAILS || env.YT_PROXY_CLIPS_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** `0:30-0:50`, or `1:02:03-1:02:23` once the clock passes an hour. */
export function formatClipTimeframe(startSec: number, endSec: number): string {
  const part = (value: number) => {
    const whole = Math.max(0, Math.round(value));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const seconds = whole % 60;
    const ss = String(seconds).padStart(2, "0");
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
    return `${minutes}:${ss}`;
  };
  return `${part(startSec)}-${part(endSec)}`;
}

export function proxyClipEmailAllowed(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!email?.trim()) return false;
  return proxyClipAllowlist(env).has(email.trim().toLowerCase());
}

export function clipOverBudget(input: {
  userCount: number;
  appCount: number;
  userBytes: number;
  appBytes: number;
  appUsd?: number;
  usdLimit?: number;
}): boolean {
  return (
    input.userCount >= CLIP_USER_DAY_COUNT ||
    input.appCount >= CLIP_APP_DAY_COUNT ||
    input.userBytes >= CLIP_USER_DAY_BYTES ||
    input.appBytes >= CLIP_APP_DAY_BYTES ||
    (input.appUsd ?? 0) >= (input.usdLimit ?? appDailyApifyUsd())
  );
}

/** Seconds to long-poll, or 0 when the wall clock is already too close to wait. */
export function apifyWaitSeconds(remainMs: number): number {
  if (!Number.isFinite(remainMs) || remainMs < 1_500) return 0;
  return Math.min(APIFY_WAIT_SEC, Math.floor(remainMs / 1000));
}

/** Actor input. `videos` is required; a flat url is rejected with 400. */
export function apifyClipInput(videoId: string, startSec: number, endSec: number): {
  videos: [{ url: string; timeframe: string; audioQuality: "best" }];
} {
  return {
    videos: [
      {
        url: canonicalYoutubeUrl(videoId),
        timeframe: formatClipTimeframe(startSec, endSec),
        audioQuality: "best",
      },
    ],
  };
}

/**
 * usageTotalUsd stays 0 for a few seconds after the run ends.
 * `AUDIO_DOWNLOADED` is $0.015. `AUDIO_LONG_EXTRA` is $0.004 per 10-minute
 * block of source length (a 50-minute video is five blocks, $0.035).
 */
export function apifyUsdFromRun(run: {
  usageTotalUsd?: number | null;
  chargedEventCounts?: Record<string, number> | null;
}): number {
  const direct = Number(run.usageTotalUsd || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const counts = run.chargedEventCounts;
  if (!counts) return 0;
  let usd = 0;
  for (const [name, raw] of Object.entries(counts)) {
    const n = Number(raw) || 0;
    if (n <= 0) continue;
    if (/AUDIO_LONG_EXTRA|10.?min/i.test(name)) usd += n * APIFY_LENGTH_BLOCK_USD;
    else if (/AUDIO_DOWNLOADED/i.test(name)) usd += n * APIFY_RESULT_USD;
  }
  return usd;
}

/**
 * Published price for a file we already saved when the charge API is still
 * zero. A 1-hour source is $0.039 (six blocks). A 50-minute source is $0.035.
 * Ten minutes or an unknown length stays at the $0.015 download.
 */
export function apifyUsdFallback(sourceDurationSec?: number | null): number {
  const duration = Number(sourceDurationSec);
  if (!Number.isFinite(duration) || duration <= 600) return APIFY_RESULT_USD;
  return APIFY_RESULT_USD + Math.ceil(duration / 600) * APIFY_LENGTH_BLOCK_USD;
}

export function apifyFailureCode(message: string): ClipErrorCode {
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/audio-download-failed|sabr-gapped/i.test(message)) return "transient";
  if (/no usable connections/i.test(message)) return "restricted";
  if (/not found/i.test(message)) return "unavailable";
  if (/age|sign[-\s]?in|restricted|region|country|not available in your/i.test(message)) {
    return "restricted";
  }
  return "unavailable";
}

/** Failure lines from a run log, or the end of the log when those lines are absent. */
export function apifyLogSignal(log: string): string {
  const tail = log.slice(-64_000);
  const marked = tail.split(/\r?\n/).filter((line) => /ACTOR_ERROR|RESULTS_JSON/i.test(line));
  if (marked.length) return marked.slice(-20).join("\n");
  return tail.slice(-8_000);
}

export function scrubToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[token]");
}

export function clipRetryable(code: ClipErrorCode, attempts: number): boolean {
  return RETRYABLE.has(code) && attempts < CLIP_ATTEMPTS;
}
