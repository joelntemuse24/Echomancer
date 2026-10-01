/**
 * Rules for a proxied YouTube section. Pure helpers: no network, no secrets
 * written to logs.
 */

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

export function proxyClipAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.YT_PROXY_CLIPS_EMAILS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
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
}): boolean {
  return (
    input.userCount >= CLIP_USER_DAY_COUNT ||
    input.appCount >= CLIP_APP_DAY_COUNT ||
    input.userBytes >= CLIP_USER_DAY_BYTES ||
    input.appBytes >= CLIP_APP_DAY_BYTES
  );
}

/** Attempt 1 keeps the configured URL. Attempt 2 swaps in a new session id. */
export function proxyUrlForAttempt(proxyUrl: string, attempt: number, sessionId: string): string {
  if (attempt < 2) return proxyUrl;
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return proxyUrl;
  }
  const user = decodeURIComponent(url.username);
  if (!user) return proxyUrl;
  const next = /session[-_][A-Za-z0-9]+/i.test(user)
    ? user.replace(/session[-_][A-Za-z0-9]+/i, `session-${sessionId}`)
    : `${user}-session-${sessionId}`;
  url.username = next;
  return url.toString();
}

export function ytDlpArgv(opts: {
  proxyUrl: string;
  pageUrl: string;
  startSec: number;
  endSec: number;
  outputPath: string;
}): string[] {
  return [
    "--no-playlist",
    "--no-write-subs",
    "--no-write-auto-subs",
    "--no-write-thumbnail",
    "--no-write-info-json",
    "--no-embed-metadata",
    "--socket-timeout",
    "20",
    "--newline",
    "--proxy",
    opts.proxyUrl,
    "-f",
    "ba[ext=m4a]/ba",
    "--download-sections",
    `*${opts.startSec}-${opts.endSec}`,
    "-o",
    opts.outputPath,
    "--",
    opts.pageUrl,
  ];
}

/** Args safe to print. The proxy value is never included. */
export function redactYtDlpArgs(args: string[]): string[] {
  const out = [...args];
  const index = out.indexOf("--proxy");
  if (index >= 0 && index + 1 < out.length) out[index + 1] = "[proxy]";
  return out;
}

export function scrubSecrets(text: string, proxyUrl: string): string {
  if (!proxyUrl) return text;
  return text.split(proxyUrl).join("[proxy]");
}

function unitBytes(amount: number, unit: string): number {
  const name = unit.toLowerCase();
  if (name === "gib") return amount * 1024 ** 3;
  if (name === "mib" || name === "mb") return amount * 1024 ** 2;
  if (name === "kib" || name === "kb") return amount * 1024;
  return amount;
}

/** Bytes transferred so far, and whether the download must stop. */
export function judgeDownloadLine(
  line: string,
  prevBytes: number
): { bytes: number; stop?: "too_big" | "range_unsupported" } {
  if (/does not support range requests|downloading the entire (file|video)/i.test(line)) {
    return { bytes: prevBytes, stop: "range_unsupported" };
  }
  let bytes = prevBytes;
  const percent = /\[download\]\s+([\d.]+)% of\s+~?([\d.]+)\s*(KiB|MiB|GiB|KB|MB|B)/i.exec(line);
  if (percent) {
    bytes = Math.max(bytes, Math.round((Number(percent[1]) / 100) * unitBytes(Number(percent[2]), percent[3]!)));
  } else {
    const absolute = /\[download\]\s+([\d.]+)\s*(KiB|MiB|GiB|KB|MB|B)\b/i.exec(line);
    if (absolute) bytes = Math.max(bytes, Math.round(unitBytes(Number(absolute[1]), absolute[2]!)));
  }
  if (bytes > CLIP_PROXY_BYTE_CAP) return { bytes, stop: "too_big" };
  return { bytes };
}

export function clipRetryable(code: ClipErrorCode, attempts: number): boolean {
  return RETRYABLE.has(code) && attempts < CLIP_ATTEMPTS;
}
