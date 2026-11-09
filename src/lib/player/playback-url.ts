/**
 * The bytes the player counts from byte 0.
 *
 * Bump when playback stops including a leading ID3 tag, or when a cached
 * redirect must not be reused for a Range request. `updated_at` stays stable
 * on a finished book, so a browser that already stored `?v=<updated_at>`
 * would keep playing the old response until this query changes.
 */
export const PLAYBACK_CONTRACT = "2";

function splitUrl(url: string): { path: string; params: URLSearchParams; hash: string } {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const bare = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = bare.indexOf("?");
  const path = qAt >= 0 ? bare.slice(0, qAt) : bare;
  const params = new URLSearchParams(qAt >= 0 ? bare.slice(qAt + 1) : "");
  return { path, params, hash };
}

/** Storage URL the player loads. Other sources (live stream) stay as given. */
export function versionedAudioUrl(
  url: string | null | undefined,
  updatedAt?: string | null
): string | null {
  if (!url) return null;
  if (!url.startsWith("/api/storage/")) return url;
  const { path, params, hash } = splitUrl(url);
  if (updatedAt) params.set("v", updatedAt);
  params.set("pb", PLAYBACK_CONTRACT);
  const q = params.toString();
  return `${path}?${q}${hash}`;
}

/** How many cache-busting reloads this storage URL has already asked for. */
export function playbackRecoveryCount(url: string | null | undefined): number {
  if (!url) return 0;
  const n = Number(splitUrl(url).params.get("r") || "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A new query so the next load misses a cached 206 or 302.
 * The element keeps the same object; only the cache key moves.
 */
export function cacheBustPlaybackUrl(url: string): string {
  const { path, params, hash } = splitUrl(url);
  const n = Number(params.get("r") || "0");
  params.set("r", String(Number.isFinite(n) && n >= 0 ? n + 1 : 1));
  return `${path}?${params.toString()}${hash}`;
}
