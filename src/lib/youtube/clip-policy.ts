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
export const CLIP_WALL_MS = 45_000;

export const CLIP_ERROR_CODES = [
  "unavailable",
  "range_unsupported",
  "too_big",
  "timeout",
  "unusable_audio",
  "restricted",
  "budget",
] as const;

export type ClipErrorCode = (typeof CLIP_ERROR_CODES)[number];

const RETRYABLE = new Set<ClipErrorCode>(["unavailable", "timeout"]);

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

/** Actor input: one URL, best audio, and a section. No proxy block. */
export function apifyClipInput(videoId: string, startSec: number, endSec: number): {
  url: string;
  audioQuality: "best";
  timeframe: string;
} {
  return {
    url: canonicalYoutubeUrl(videoId),
    audioQuality: "best",
    timeframe: formatClipTimeframe(startSec, endSec),
  };
}

export function scrubToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[token]");
}

export function clipRetryable(code: ClipErrorCode, attempts: number): boolean {
  return RETRYABLE.has(code) && attempts < CLIP_ATTEMPTS;
}
