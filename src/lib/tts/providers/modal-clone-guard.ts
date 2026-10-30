/**
 * Guards around the self-hosted S2-Pro clone path.
 *
 * The October 25 attempt left requests Pending while several H100s each
 * spent about 20 minutes compiling. These checks decide, before a synthesize
 * call, whether Modal should be asked at all: a warm container, a daily
 * character budget, and a take that is long enough for the text.
 */

/** Product narration rate. `CHARS_PER_AUDIO_HOUR` (54_000) is 900 × 60. */
export const CLONE_CHARS_PER_AUDIO_MINUTE = 900;

/**
 * A take shorter than this fraction of the 900-character pace is truncated.
 *
 * 900 characters a minute is about 150 words a minute. A fast read at 200
 * words a minute still lasts about three quarters of that, so it stays above
 * a floor of one half. A frame-cap cutoff that drops a paragraph lands under
 * half. Sections whose expected audio is under {@link CLONE_DURATION_MIN_EXPECTED_S}
 * skip the ratio; the server's `truncated_units` still rejects those.
 */
export const CLONE_DURATION_MIN_RATIO = 0.5;

/** About 120 characters. Shorter lines are headings, not truncated chapters. */
export const CLONE_DURATION_MIN_EXPECTED_S = 8;

export const MODAL_CLONE_TIMEOUT_DEFAULT_MS = 60_000;
export const MODAL_CLONE_TIMEOUT_MIN_MS = 30_000;
export const MODAL_CLONE_TIMEOUT_MAX_MS = 60_000;
export const MODAL_CLONE_READY_TIMEOUT_DEFAULT_MS = 5_000;

/** One long book per user per UTC day, then Drama 3. */
export const DEFAULT_MODAL_USER_DAILY_CHARS = 500_000;
/** A few books across everyone, then Drama 3. */
export const DEFAULT_MODAL_GLOBAL_DAILY_CHARS = 2_000_000;

const MODAL_CLONE_SPEND_ACTION = "modal_s2_clone";

const blockedJobs = new Set<string>();

export function resetModalCloneGuardForTests(): void {
  blockedJobs.clear();
}

export function modalCloneJobBlocked(jobId?: string | null): boolean {
  return Boolean(jobId && blockedJobs.has(jobId));
}

export function blockModalCloneJob(jobId: string): void {
  if (jobId) blockedJobs.add(jobId);
}

export function modalCloneCallTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return clampMs(
    env.MODAL_S2_TIMEOUT_MS,
    MODAL_CLONE_TIMEOUT_DEFAULT_MS,
    MODAL_CLONE_TIMEOUT_MIN_MS,
    MODAL_CLONE_TIMEOUT_MAX_MS
  );
}

export function modalCloneReadyTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return clampMs(env.MODAL_S2_READY_TIMEOUT_MS, MODAL_CLONE_READY_TIMEOUT_DEFAULT_MS, 1_000, 15_000);
}

/** `MODAL_S2_READY=0` skips the probe. The synthesize timeout still applies. */
export function modalCloneReadyProbeEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.MODAL_S2_READY !== "0";
}

export function modalCloneCharCaps(env: NodeJS.ProcessEnv = process.env): {
  user: number;
  global: number;
} {
  return {
    user: readCap(env.MODAL_S2_USER_DAILY_CHARS, DEFAULT_MODAL_USER_DAILY_CHARS),
    global: readCap(env.MODAL_S2_GLOBAL_DAILY_CHARS, DEFAULT_MODAL_GLOBAL_DAILY_CHARS),
  };
}

export function utcDayStartUnix(now = new Date()): number {
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
  );
}

export function cloneTakeIsTruncated(input: {
  text: string;
  durationSeconds: number;
  truncatedUnits?: number;
}): { truncated: boolean; reason?: string } {
  const units = Number(input.truncatedUnits ?? 0);
  if (Number.isFinite(units) && units > 0) {
    return { truncated: true, reason: `truncated_units=${units}` };
  }
  const chars = Math.max(0, input.text?.length ?? 0);
  const expected = (chars / CLONE_CHARS_PER_AUDIO_MINUTE) * 60;
  if (expected < CLONE_DURATION_MIN_EXPECTED_S) return { truncated: false };
  const duration = input.durationSeconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    return { truncated: true, reason: "missing duration" };
  }
  const floor = expected * CLONE_DURATION_MIN_RATIO;
  if (duration < floor) {
    return {
      truncated: true,
      reason: `duration ${duration.toFixed(1)}s is under half of ${expected.toFixed(1)}s at 900 chars/min`,
    };
  }
  return { truncated: false };
}

/**
 * True when this job's remaining characters fit both daily caps.
 * A book that does not fit is blocked so every section uses the fallback
 * voice, instead of switching narrator at the cap.
 */
export async function ensureModalCloneJobAllowed(opts: {
  jobId: string;
  userId: string;
  chars: number;
}): Promise<boolean> {
  if (!opts.jobId) return false;
  if (blockedJobs.has(opts.jobId)) return false;
  if (opts.chars <= 0) return true;
  const ok = await modalCloneSpendAllowed(opts.userId || "anonymous", opts.chars);
  if (!ok) blockedJobs.add(opts.jobId);
  return ok;
}

export async function modalCloneSpendAllowed(
  userId: string,
  chars: number
): Promise<boolean> {
  if (chars <= 0) return true;
  const caps = modalCloneCharCaps();
  if (!Number.isFinite(caps.user) && !Number.isFinite(caps.global)) return true;
  let userChars = 0;
  let globalChars = 0;
  try {
    const { queryOne } = await import("@/lib/turso");
    if (typeof queryOne !== "function") return false;
    const row = await queryOne<{
      user_chars: number | bigint | null;
      global_chars: number | bigint | null;
    }>(
      `SELECT
         COALESCE(SUM(chars_processed), 0) AS global_chars,
         COALESCE(SUM(CASE WHEN user_id = ? THEN chars_processed ELSE 0 END), 0) AS user_chars
       FROM usage_logs
       WHERE action = ? AND created_at >= ?`,
      [userId || "anonymous", MODAL_CLONE_SPEND_ACTION, utcDayStartUnix()]
    );
    userChars = asCount(row?.user_chars);
    globalChars = asCount(row?.global_chars);
  } catch (err) {
    console.warn(
      "[modal-clone] spend check failed; skipping Modal:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
  if (Number.isFinite(caps.user) && userChars + chars > caps.user) return false;
  if (Number.isFinite(caps.global) && globalChars + chars > caps.global) return false;
  return true;
}

/** Record characters actually sent to Modal. A failed insert does not throw. */
export async function reserveModalCloneSpend(
  userId: string,
  chars: number
): Promise<boolean> {
  if (chars <= 0) return true;
  try {
    const { execute } = await import("@/lib/turso");
    if (typeof execute !== "function") return true;
    await execute(
      `INSERT INTO usage_logs (user_id, action, chars_processed)
       VALUES (?, ?, ?)`,
      [userId || "anonymous", MODAL_CLONE_SPEND_ACTION, Math.floor(chars)]
    );
    return true;
  } catch (err) {
    console.warn(
      "[modal-clone] spend reserve failed; skipping Modal:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

function clampMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(raw);
  const chosen = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.min(max, Math.max(min, chosen));
}

function readCap(raw: string | undefined, fallback: number): number {
  const text = raw?.trim().toLowerCase();
  if (!text) return fallback;
  if (text === "off" || text === "unlimited") return Number.POSITIVE_INFINITY;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function asCount(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
