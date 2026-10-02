/**
 * Rules for a server-side YouTube section. Pure helpers. The Apify token
 * never appears in these strings.
 */

import { canonicalYoutubeUrl } from "@/lib/youtube/range";

export const CLIP_MIN_SEC = 10;
export const CLIP_MAX_SEC = 40;
export const CLIP_DEFAULT_SEC = 20;
/** A 40 s WAV from the segment actor is ~7.7 MB; 16 MiB leaves headroom. */
export const CLIP_PROXY_BYTE_CAP = 16 * 1024 * 1024;
export const CLIP_USER_DAY_COUNT = 15;
export const CLIP_APP_DAY_COUNT = 200;
/** WAV sections are ~4× the old opus bytes; the count and USD caps stay the binding limits. */
export const CLIP_USER_DAY_BYTES = 128 * 1024 * 1024;
export const CLIP_APP_DAY_BYTES = 2 * 1024 * 1024 * 1024;
export const CLIP_ATTEMPTS = 2;
/** Per-attempt wall clock. A 50-minute lecture took 77s on the link actor. Short videos finish in 24–37s; the segment actor finished every bench in 27–44s. */
export const CLIP_WALL_MS = 90_000;
/** The link actor on a long source (fallback only) needed up to 150s in the bench. */
export const CLIP_LINK_LONG_WALL_MS = 180_000;
/** The runs API accepts at most 60 seconds of waitForFinish. */
export const APIFY_WAIT_SEC = 60;
/** Abort the link actor once this run would cost about five cents. */
export const APIFY_MAX_RUN_USD = 0.05;
/** The segment actor charges $0.05 + $0.04/min, so one clip is ~$0.09. */
export const APIFY_SEGMENT_MAX_RUN_USD = 0.15;
export const APIFY_RESULT_USD = 0.015;
export const APIFY_LENGTH_BLOCK_USD = 0.004;
export const APIFY_SEGMENT_VIDEO_USD = 0.05;
export const APIFY_SEGMENT_MINUTE_USD = 0.04;
export const APIFY_ACTOR_START_USD = 0.00005;

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

/** Worth one try on the other actor. A budget stop is account-wide, so it is not. */
const FALLBACKABLE = new Set<ClipErrorCode>([
  "restricted",
  "transient",
  "timeout",
  "range_unsupported",
  "too_big",
  "unavailable",
]);

export type ClipActor = "link" | "segment";

export const CLIP_ACTOR_IDS: Record<ClipActor, string> = {
  link: "utils~youtube-link",
  segment: "entertained_rattlesnake~youtube-audio-segment-downloader",
};

/** Sources at least this long go to the segment actor first (yt-dlp --download-sections). */
export function clipSegmentSourceSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CLIP_SEGMENT_SOURCE_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30 * 60;
}

export function clipActorOrder(
  videoSeconds: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): [ClipActor, ClipActor] {
  const long =
    videoSeconds != null && Number.isFinite(videoSeconds) && videoSeconds >= clipSegmentSourceSec(env);
  return long ? ["segment", "link"] : ["link", "segment"];
}

export function clipAttemptWallMs(
  actor: ClipActor,
  videoSeconds: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  if (actor === "segment") return CLIP_WALL_MS;
  const long =
    videoSeconds != null && Number.isFinite(videoSeconds) && videoSeconds >= clipSegmentSourceSec(env);
  return long ? CLIP_LINK_LONG_WALL_MS : CLIP_WALL_MS;
}

export function clipActorMaxRunUsd(actor: ClipActor): number {
  return actor === "segment" ? APIFY_SEGMENT_MAX_RUN_USD : APIFY_MAX_RUN_USD;
}

export function clipFallbackable(code: ClipErrorCode): boolean {
  return FALLBACKABLE.has(code);
}

/** Segment actor minimum for a clip that produced audio: $0.05 + $0.04 per started minute. */
export function apifySegmentFloorUsd(lengthSec: number): number {
  const minutes = Math.max(1, Math.ceil(Math.max(1, lengthSec) / 60));
  return APIFY_SEGMENT_VIDEO_USD + minutes * APIFY_SEGMENT_MINUTE_USD;
}

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

/** Link-actor input. `videos` is required; a flat url is rejected with 400. */
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
 * Segment-actor input. Seconds as strings match the benched calls; the actor
 * turns them into `yt-dlp --download-sections`. `transcribe` stays off so the
 * run does not pay for or wait on a transcript nobody reads.
 */
export function apifySegmentClipInput(
  videoId: string,
  startSec: number,
  endSec: number
): {
  videos: [string];
  format: "wav";
  startTime: string;
  endTime: string;
  transcribe: false;
} {
  return {
    videos: [canonicalYoutubeUrl(videoId)],
    format: "wav",
    startTime: String(Math.max(0, Math.round(startSec))),
    endTime: String(Math.max(0, Math.round(endSec))),
    transcribe: false,
  };
}

/**
 * usageTotalUsd stays 0 for a few seconds after the run ends.
 * Link actor: `AUDIO_DOWNLOADED` is $0.015, `AUDIO_LONG_EXTRA` is $0.004 per
 * 10-minute block of source length (a 50-minute video is five blocks, $0.035).
 * Segment actor: `video-started` is $0.05, `audio-minute-processed` is $0.04
 * per started minute, `apify-actor-start` is $0.00005.
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
    else if (/video-started/i.test(name)) usd += n * APIFY_SEGMENT_VIDEO_USD;
    else if (/audio-minute/i.test(name)) usd += n * APIFY_SEGMENT_MINUTE_USD;
    else if (/actor-start/i.test(name)) usd += n * APIFY_ACTOR_START_USD;
  }
  return usd;
}

export function apifyFailureCode(message: string): ClipErrorCode {
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/audio-download-failed|sabr-gapped/i.test(message)) return "transient";
  if (/no usable connections/i.test(message)) return "restricted";
  if (/not found/i.test(message)) return "unavailable";
  if (/not a bot|bot check|captcha/i.test(message)) return "restricted";
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
