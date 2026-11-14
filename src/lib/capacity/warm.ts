/**
 * Shared cold-start for the general CPU app and the Kokoro CPU app that
 * serves Drew, Walter, and George.
 *
 * One row per pool, not per person. A click inside the hold does not extend
 * it and does not send another request, so it cannot keep a container up or
 * start a second one. A busy answer is capacity already: it is not retried.
 * The hold is five minutes, the same idle window the apps scale down on.
 * min_containers stays 0. This does not create a task, a job, or audio.
 */

import { execute, queryOne } from "@/lib/turso";
import { georgeEndpoint, georgeReady } from "@/lib/tts/george-voice";
import { sowellEndpoint, sowellReady } from "@/lib/tts/sowell-voice";
import { drewEndpoint, drewReady } from "@/lib/tts/drew-voice";
import { isKokoroCpuVoiceId } from "@/lib/tts/kokoro-voice-ids";

export const WARM_HOLD_MS = 300_000;

export type WarmPool = "cpu" | "kokoro";
export type WarmReason = "create" | "voice";
export type WarmPostResult = "ready" | "unreachable" | "unconfigured";

export function poolsForWarm(input: {
  reason: WarmReason;
  voiceId?: string | null;
}): WarmPool[] {
  const voice = (input.voiceId ?? "").trim();
  const kokoro = isKokoroCpuVoiceId(voice);
  if (input.reason === "voice") return kokoro ? ["kokoro"] : [];
  return kokoro ? ["cpu", "kokoro"] : ["cpu"];
}

type WarmRow = { started_at: number };

/** True when this caller owns the hold. A live row is left unchanged. */
export async function claimWarmPool(
  pool: WarmPool,
  now: number
): Promise<{ claimed: boolean; startedAt: number }> {
  const expiresAt = now + WARM_HOLD_MS;
  const row = await queryOne<WarmRow>(
    `INSERT INTO capacity_warms (pool, started_at, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(pool) DO UPDATE SET
       started_at = excluded.started_at,
       expires_at = excluded.expires_at
     WHERE capacity_warms.expires_at <= excluded.started_at
     RETURNING started_at`,
    [pool, now, expiresAt]
  );
  if (!row) return { claimed: false, startedAt: 0 };
  return { claimed: Number(row.started_at) === now, startedAt: Number(row.started_at) };
}

/** Drop only the hold this caller wrote. A newer hold stays. */
export async function releaseWarmPool(pool: WarmPool, startedAt: number): Promise<void> {
  await execute(
    `DELETE FROM capacity_warms WHERE pool = ? AND started_at = ?`,
    [pool, startedAt]
  );
}

function hostUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function kokoroTarget(env: NodeJS.ProcessEnv): { url: string; token: string } | null {
  // Drew first: it is the default narrator, so its endpoint is the one a
  // create-flow warm must reach when more than one is configured.
  try {
    if (drewReady(env)) {
      return { url: drewEndpoint(env), token: env.DREW_TOKEN?.trim() || "" };
    }
  } catch {
    /* the next configured voice is the same app. */
  }
  try {
    if (sowellReady(env)) {
      return { url: sowellEndpoint(env), token: env.SOWELL_TOKEN?.trim() || "" };
    }
  } catch {
    /* George's endpoint is the same app when Sowell is unset. */
  }
  try {
    if (georgeReady(env)) {
      return { url: georgeEndpoint(env), token: env.GEORGE_TOKEN?.trim() || "" };
    }
  } catch {
    return null;
  }
  return null;
}

export function warmTarget(
  pool: WarmPool,
  env: NodeJS.ProcessEnv = process.env
): { url: string; token: string } | null {
  if (pool === "cpu") {
    const url = hostUrl(env.MODAL_CPU_URL);
    const token = env.MODAL_CPU_TOKEN?.trim() || "";
    if (!url || !token) return null;
    return { url, token };
  }
  return kokoroTarget(env);
}

function unreachable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "TimeoutError" || name === "AbortError") return false;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
}

/**
 * One POST. 429 and any other answer count as the pool being there.
 * A timeout counts too: the placement may already be starting, and a second
 * POST would be another container. Only a connection that never left is
 * `unreachable`, and that hold is released so a later click can try.
 */
export async function postWarm(
  pool: WarmPool,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<WarmPostResult> {
  const target = warmTarget(pool, env);
  if (!target) return "unconfigured";
  try {
    await fetchImpl(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({ warm: true }),
      signal: AbortSignal.timeout(45_000),
    });
    return "ready";
  } catch (err) {
    if (unreachable(err)) return "unreachable";
    return "ready";
  }
}

function workerTarget(env: NodeJS.ProcessEnv): { url: string; secret: string } | null {
  const raw = (env.WORKER_URL || env.TAKEHOME_WORKER_URL || "").trim();
  const secret = (
    env.WORKER_SECRET ||
    env.TAKEHOME_WORKER_SECRET ||
    env.INTERNAL_JOB_SECRET ||
    ""
  ).trim();
  if (!raw || !secret) return null;
  try {
    const url = new URL(raw);
    return { url: url.origin, secret };
  } catch {
    return null;
  }
}

async function finishClaim(
  pool: WarmPool,
  startedAt: number,
  result: WarmPostResult,
  posted: WarmPool[]
): Promise<void> {
  if (result === "ready") {
    posted.push(pool);
    return;
  }
  await releaseWarmPool(pool, startedAt).catch((err) => {
    console.error(`[capacity] warm release failed for ${pool}`, err);
  });
}

/**
 * Claim first, then one POST per new hold. When the take-home worker is
 * configured, it makes the provider call so the Modal tokens stay there.
 */
export async function warmSharedCapacity(input: {
  reason: WarmReason;
  voiceId?: string | null;
  now?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ pools: WarmPool[]; posted: WarmPool[] }> {
  const pools = poolsForWarm(input);
  const now = input.now ?? Date.now();
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const posted: WarmPool[] = [];
  const claimed: { pool: WarmPool; startedAt: number }[] = [];
  for (const pool of pools) {
    try {
      const claim = await claimWarmPool(pool, now);
      if (claim.claimed) claimed.push({ pool, startedAt: claim.startedAt });
    } catch (err) {
      // No row was kept. The next click can try. This click does not POST.
      console.error(`[capacity] warm claim failed for ${pool}`, err);
    }
  }
  if (claimed.length === 0) return { pools, posted };

  const worker = workerTarget(env);
  if (worker) {
    let results: Partial<Record<WarmPool, WarmPostResult>> = {};
    try {
      const response = await fetchImpl(`${worker.url}/capacity-warm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${worker.secret}`,
        },
        body: JSON.stringify({ pools: claimed.map((item) => item.pool) }),
        signal: AbortSignal.timeout(50_000),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          results?: Partial<Record<WarmPool, WarmPostResult>>;
        };
        results = body.results ?? {};
      }
    } catch (err) {
      if (!unreachable(err)) {
        for (const item of claimed) posted.push(item.pool);
        return { pools, posted };
      }
    }
    for (const item of claimed) {
      await finishClaim(item.pool, item.startedAt, results[item.pool] ?? "unreachable", posted);
    }
    return { pools, posted };
  }

  for (const item of claimed) {
    const result = await postWarm(item.pool, env, fetchImpl);
    await finishClaim(item.pool, item.startedAt, result, posted);
  }
  return { pools, posted };
}
