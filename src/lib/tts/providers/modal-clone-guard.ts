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

/**
 * Which narrator engine a book is committed to.
 *
 * A book must never change narrator halfway through. The choice is made once,
 * stored on the job (`jobs.provider_pin`), and every later section either uses
 * it or fails visibly. Previously a Modal failure fell through to Drama 3 per
 * section, so a slow container could hand someone a book that changes voice at
 * section 12 with no notice.
 */
export type CloneProviderChoice = "modal" | "drama3" | "fish";

export const CLONE_PROVIDER_PIN_VALUES: readonly CloneProviderChoice[] = [
  "modal",
  "drama3",
  "fish",
];

export function parseCloneProviderPin(
  raw: unknown
): CloneProviderChoice | null {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (CLONE_PROVIDER_PIN_VALUES as readonly string[]).includes(text)
    ? (text as CloneProviderChoice)
    : null;
}

/** Shown on a finished book whose sections came from more than one engine. */
export const CLONE_PROVIDER_SWITCH_WARNING =
  "Part of this book used the backup narrator while your cloned voice was preparing. Regenerate to hear it in your voice throughout.";

/** Shown when the deferred wait for a warm container ran out. */
export const CLONE_COLD_TIMEOUT_WARNING =
  "Your cloned voice took too long to start. The rest of this book used the backup narrator.";

/**
 * Shown when the clone engine answered with a hard fault for the whole defer
 * window. Distinct from {@link CLONE_COLD_TIMEOUT_WARNING}: nothing was cold,
 * the provider was broken, and saying so is what makes the next incident
 * diagnosable from the job row alone.
 */
export const CLONE_PROVIDER_FAULT_WARNING =
  "The cloned voice service returned an error while this book was being made. The rest of this book used the backup narrator.";

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

// ── lanes, cold start, and deferral ────────────────────────────────────────

/**
 * Target container shape: one frozen deployed app, four independent one-GPU
 * containers, `min_containers=0`. `S2C_MAX_CONTAINERS` on the Modal side is
 * the hard cap; this is how many concurrent batch calls this worker aims for.
 * A lane beyond the server cap just queues inside Modal, so the two values
 * should match after staging.
 */
export const MODAL_CLONE_LANES_DEFAULT = 4;
export const MODAL_CLONE_LANES_MAX = 8;

export function modalCloneLanes(env: NodeJS.ProcessEnv = process.env): number {
  return clampInt(env.MODAL_S2_SECTION_CONCURRENCY, MODAL_CLONE_LANES_DEFAULT, 1, MODAL_CLONE_LANES_MAX);
}

/** Sections per HTTP call. One lane carries this many rows of one decode batch. */
export const MODAL_CLONE_BATCH_DEFAULT = 24;
export const MODAL_CLONE_BATCH_MAX = 32;

export function modalCloneBatchItems(env: NodeJS.ProcessEnv = process.env): number {
  return clampInt(env.MODAL_S2_BATCH_SIZE, MODAL_CLONE_BATCH_DEFAULT, 1, MODAL_CLONE_BATCH_MAX);
}

/**
 * How long one book placement may wait for a cold container.
 *
 * A snapshot restore is about 30–90 s. A compile on an unseen worker variant
 * is 8–16 min, and the HTTP proxy kills that compile at ~542 s, so the book
 * never gets a snapshot out of waiting. The ceiling is under both: a mis-set
 * `MODAL_S2_COLD_WAIT_MS` cannot make a customer book sit through a compile.
 * The compile is finished off this path by `modal run …::cover`.
 */
export const MODAL_CLONE_COLD_WAIT_DEFAULT_MS = 150_000;
export const MODAL_CLONE_COLD_WAIT_MIN_MS = 0;
/** Longest a book may block on one placement. Under an 8 min compile and the ~542 s proxy kill. */
export const MODAL_CLONE_COLD_WAIT_MAX_MS = 180_000;
/** Shortest wall time that means "this call compiled", not "it restored". */
export const MODAL_CLONE_COMPILE_FLOOR_MS = 8 * 60_000;

export function modalCloneColdWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MODAL_S2_COLD_WAIT_MS ?? "").trim();
  if (!raw) return MODAL_CLONE_COLD_WAIT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MODAL_CLONE_COLD_WAIT_DEFAULT_MS;
  return Math.max(
    MODAL_CLONE_COLD_WAIT_MIN_MS,
    Math.min(MODAL_CLONE_COLD_WAIT_MAX_MS, Math.floor(n))
  );
}

/**
 * How long a job waits out a cold pool before it is allowed to fall back.
 *
 * The book is asynchronous: nothing in the browser is holding a request open,
 * so the right answer to "no warm container yet" is to come back later, not to
 * quietly switch narrators. `MODAL_S2_DEFER_MS=0` disables waiting and gives
 * the old fail-fast behaviour back for a rollback.
 */
export const MODAL_CLONE_DEFER_DEFAULT_MS = 25 * 60_000;
export const MODAL_CLONE_DEFER_MAX_MS = 6 * 60 * 60_000;

/**
 * How long the **first-light** call waits for a restore.
 *
 * A book's normal placement may wait the full `MODAL_S2_COLD_WAIT_MS` (150 s),
 * because a book that parks simply resumes later. The call that delivers
 * section 0 is different: its wait is wall clock the person is sitting in
 * front of, and a placement that is *compiling* will not answer inside any
 * budget a book may use (#237). Giving up earlier loses nothing — the retry
 * wave tries another container, and the off-path RPC finishes the compile —
 * while it turns "stuck behind a 150 s compile wait" into "retried on another
 * container in 75 s".
 *
 * Default 75 s: a measured restore is ~57 s, so this still covers a real
 * restore with ~18 s of margin, and it is half the normal budget so a bad
 * placement is abandoned twice as fast. `MODAL_S2_FIRST_LIGHT_WAIT_MS=0`
 * falls back to the full cold wait.
 */
export const MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS = 75_000;

/**
 * Extra time a call needs beyond narration: reference encode, prompt
 * preparation, and codec decode of the finished rows.
 *
 * Measured on `job 7e4a8b48`: 28.3s of execution for 15.9s of generation on a
 * single 2-unit row, i.e. ~12s of preparation. A lane that carries more rows
 * pays it once per call, not per row, so it is a constant, not a multiplier.
 */
export const MODAL_CLONE_CALL_PREP_MS = 20_000;

export function modalCloneFirstLightWaitMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = (env.MODAL_S2_FIRST_LIGHT_WAIT_MS ?? "").trim();
  if (!raw) return MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS;
  if (n <= 0) return modalCloneColdWaitMs(env);
  // Never longer than a normal placement: this budget exists to be shorter.
  return Math.min(modalCloneColdWaitMs(env), Math.floor(n));
}

export function modalCloneDeferMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MODAL_S2_DEFER_MS ?? "").trim();
  if (!raw) return MODAL_CLONE_DEFER_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return MODAL_CLONE_DEFER_DEFAULT_MS;
  return Math.min(MODAL_CLONE_DEFER_MAX_MS, Math.floor(n));
}

/**
 * Backoff between attempts to reach a pool that has no warm container. Starts
 * short because a restore finishes in about a minute; the ceiling keeps a
 * genuinely down endpoint from being hammered for the whole defer window.
 */
export const MODAL_CLONE_RETRY_BASE_MS = 15_000;
export const MODAL_CLONE_RETRY_MAX_MS = 120_000;

/**
 * Render section 0 alone before opening the rest of the fan-out.
 *
 * Default on. Nothing is playable until section 0 is, so a fan-out that opens
 * every lane at once on a scaled-to-zero pool makes the person wait for the
 * whole wave (and pays several cold restores) before they can hear anything.
 * `MODAL_S2_FIRST_LIGHT=0` restores the older all-lanes-at-once wave, which is
 * faster to a *finished* book and slower to the first second of audio.
 */
export function modalCloneFirstLightEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = (env.MODAL_S2_FIRST_LIGHT ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

export function modalCloneRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(MODAL_CLONE_RETRY_MAX_MS, MODAL_CLONE_RETRY_BASE_MS * 2 ** (n - 1));
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(raw);
  const chosen = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.min(max, Math.max(min, chosen));
}

