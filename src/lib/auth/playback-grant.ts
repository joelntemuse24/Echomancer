import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionSecret } from "@/lib/auth/session";

/** How long a playback grant skips the storage ownership read. */
export const PLAYBACK_GRANT_TTL_MS = 2 * 60 * 1000;
/** A warm isolate reuses one ownership answer for this long. */
export const PLAYBACK_AUTH_CACHE_MS = 60_000;

const RESOURCE_PREFIXES = new Set(["audiobooks", "pdfs", "clones"]);

function resourceKey(userId: string, storagePath: string): string | null {
  const [prefix, id] = storagePath.split("/");
  if (!prefix || !id || !RESOURCE_PREFIXES.has(prefix)) return null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  return `${userId}\n${prefix}/${id}`;
}

/**
 * Grant covering one owned folder (`audiobooks/<jobId>`). The expiry is
 * bucketed so the same caller gets the same token for the whole window.
 * Possession is not enough: the storage route still requires this session.
 */
export function signPlaybackGrant(
  userId: string,
  prefix: string,
  now = Date.now()
): string {
  const windowEnd = (Math.floor(now / PLAYBACK_GRANT_TTL_MS) + 1) * PLAYBACK_GRANT_TTL_MS;
  const exp = windowEnd - now < 20_000 ? windowEnd + PLAYBACK_GRANT_TTL_MS : windowEnd;
  const body = `${exp.toString(36)}~${prefix}`;
  const mac = createHmac("sha256", getSessionSecret())
    .update(`${userId}\n${body}`)
    .digest("base64url");
  return `${body}~${mac}`;
}

export function playbackGrantAllows(
  userId: string,
  storagePath: string,
  token: string | null | undefined,
  now = Date.now()
): boolean {
  if (!token) return false;
  const split = token.split("~");
  if (split.length !== 3) return false;
  const [exp36, prefix, mac] = split;
  if (!exp36 || !prefix || !mac) return false;
  if (!resourceKey(userId, storagePath)) return false;
  const exp = Number.parseInt(exp36, 36);
  if (!Number.isFinite(exp) || exp < now) return false;
  if (storagePath !== prefix && !storagePath.startsWith(`${prefix}/`)) return false;
  const body = `${exp36}~${prefix}`;
  const expected = createHmac("sha256", getSessionSecret())
    .update(`${userId}\n${body}`)
    .digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const authFreshUntil = new Map<string, number>();

export function rememberPlaybackAuth(
  userId: string,
  storagePath: string,
  now = Date.now()
): void {
  const key = resourceKey(userId, storagePath);
  if (!key) return;
  authFreshUntil.set(key, now + PLAYBACK_AUTH_CACHE_MS);
  if (authFreshUntil.size <= 4_000) return;
  const oldest = authFreshUntil.keys().next().value;
  if (oldest) authFreshUntil.delete(oldest);
}

export function playbackAuthFresh(
  userId: string,
  storagePath: string,
  now = Date.now()
): boolean {
  const key = resourceKey(userId, storagePath);
  if (!key) return false;
  const until = authFreshUntil.get(key);
  if (until == null) return false;
  if (until > now) return true;
  authFreshUntil.delete(key);
  return false;
}

/** Tests reset the warm-isolate cache. */
export function clearPlaybackAuthCache(): void {
  authFreshUntil.clear();
}
