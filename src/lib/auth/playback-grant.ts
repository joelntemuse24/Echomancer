import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionSecret } from "@/lib/auth/session";

/** How long a playback grant stays signed. The storage route still re-reads the row. */
export const PLAYBACK_GRANT_TTL_MS = 2 * 60 * 1000;

const RESOURCE_PREFIXES = new Set(["audiobooks", "pdfs", "clones"]);

function resourceKey(userId: string, storagePath: string): string | null {
  const [prefix, id] = storagePath.split("/");
  if (!prefix || !id || !RESOURCE_PREFIXES.has(prefix)) return null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  return `${userId}\n${prefix}/${id}`;
}

export type PlaybackGrant = { prefix: string; nonce: number };

/**
 * Grant covering one owned folder (`audiobooks/<jobId>`). The expiry is
 * bucketed so the same caller gets the same token for the whole window, and
 * the last 20 seconds of a window also cover the next one. The nonce is the
 * row's `playback_nonce`. Deleting the book or moving it bumps that value,
 * so a grant that is still inside this window stops working on the next read.
 */
export function signPlaybackGrant(
  userId: string,
  prefix: string,
  now = Date.now(),
  nonce = 0
): string {
  const windowEnd = (Math.floor(now / PLAYBACK_GRANT_TTL_MS) + 1) * PLAYBACK_GRANT_TTL_MS;
  const exp = windowEnd - now < 20_000 ? windowEnd + PLAYBACK_GRANT_TTL_MS : windowEnd;
  const body = `${exp.toString(36)}~${prefix}~${Math.max(0, Math.floor(nonce)).toString(36)}`;
  const mac = createHmac("sha256", getSessionSecret())
    .update(`${userId}\n${body}`)
    .digest("base64url");
  return `${body}~${mac}`;
}

/** A signature that is still inside its window. It does not, by itself, allow playback. */
export function readPlaybackGrant(
  userId: string,
  storagePath: string,
  token: string | null | undefined,
  now = Date.now()
): PlaybackGrant | null {
  if (!token || !resourceKey(userId, storagePath)) return null;
  const split = token.split("~");
  if (split.length !== 4) return null;
  const [exp36, prefix, nonce36, mac] = split;
  if (!exp36 || !prefix || !nonce36 || !mac) return null;
  const exp = Number.parseInt(exp36, 36);
  const nonce = Number.parseInt(nonce36, 36);
  if (!Number.isFinite(exp) || exp < now || !Number.isFinite(nonce) || nonce < 0) return null;
  if (storagePath !== prefix && !storagePath.startsWith(`${prefix}/`)) return null;
  const body = `${exp36}~${prefix}~${nonce36}`;
  const expected = createHmac("sha256", getSessionSecret())
    .update(`${userId}\n${body}`)
    .digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return { prefix, nonce };
}

export function playbackRowAllows(
  row: { user_id: string; deleted_at: number | null; playback_nonce: number | null } | null,
  sessionUserId: string,
  nonce: number
): boolean {
  if (!row || row.deleted_at != null) return false;
  if (row.user_id !== sessionUserId) return false;
  return Number(row.playback_nonce ?? 0) === nonce;
}
