/**
 * YouTube Data API v3 search. Server-only — the key never reaches the browser.
 * The route allows this only for a signed-in user. Hits are cached for 10
 * minutes in Turso so another isolate does not call search.list again.
 */

import {
  canonicalYoutubeUrl,
  defaultSpeechRange,
  isYoutubeVideoId,
  parseIso8601Duration,
  parseYoutubeVideoId,
  youtubeThumbnailUrl,
} from "@/lib/youtube/range";

export type YoutubeSearchHit = {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnailUrl: string;
  url: string;
  suggestedRange: { startSec: number; endSec: number } | null;
};

const SEARCH_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 80;

type CacheEntry<T> = { at: number; value: T };

const searchCache = new Map<string, CacheEntry<YoutubeSearchHit[]>>();

/** Drop this isolate's copy so the next read has to use the shared table. */
export function forgetYoutubeSearchMemory(): void {
  searchCache.clear();
}

export async function clearYoutubeSearchCache(): Promise<void> {
  searchCache.clear();
  try {
    const { execute } = await import("@/lib/turso");
    await execute(`DELETE FROM youtube_search_cache`);
  } catch {
    /* The table is created on the search route. Unit tests may not have it. */
  }
}

export function youtubeApiKey(): string | undefined {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  return key || undefined;
}

export async function searchYoutube(query: string): Promise<YoutubeSearchHit[]> {
  const key = youtubeApiKey();
  if (!key) {
    throw new YoutubeSearchError("missing-key");
  }
  const trimmed = query.trim().slice(0, 200);
  if (!trimmed) return [];

  const videoId = parseYoutubeVideoId(trimmed);
  if (videoId) {
    const one = await lookupYoutubeVideo(videoId, key);
    return one ? [one] : [];
  }

  const cacheKey = normalizeQuery(trimmed);
  const cached = await readCachedSearch(cacheKey);
  if (cached) return cached;

  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("maxResults", "8");
  searchUrl.searchParams.set("q", trimmed);
  searchUrl.searchParams.set("videoEmbeddable", "true");
  searchUrl.searchParams.set("safeSearch", "moderate");
  searchUrl.searchParams.set("key", key);

  const search = (await getJson(searchUrl)) as { items?: SearchItem[] };
  const candidates = (search.items ?? []).flatMap((item) => {
    const id = item.id?.videoId;
    if (!isYoutubeVideoId(id)) return [];
    if (item.snippet?.liveBroadcastContent === "live") return [];
    return [{ videoId: id, snippet: item.snippet }];
  });
  if (candidates.length === 0) {
    await writeCachedSearch(cacheKey, []);
    return [];
  }

  const durations = await fetchDurations(
    candidates.map((item) => item.videoId),
    key
  );
  const hits = candidates.flatMap((item) => {
    const durationSec = durations.get(item.videoId);
    if (durationSec == null || durationSec < 10) return [];
    return [hitFromSnippet(item.videoId, item.snippet, durationSec)];
  });
  await writeCachedSearch(cacheKey, hits);
  return hits;
}

export async function lookupYoutubeVideo(
  videoId: string,
  key = youtubeApiKey()
): Promise<YoutubeSearchHit | null> {
  if (!key || !isYoutubeVideoId(videoId)) return null;
  const cacheKey = `v:${videoId}`;
  const cached = await readCachedSearch(cacheKey);
  if (cached) return cached[0] ?? null;
  const durations = await fetchDurations([videoId], key);
  const durationSec = durations.get(videoId);
  if (durationSec == null || durationSec < 10) {
    await writeCachedSearch(cacheKey, []);
    return null;
  }
  const hit = hitFromSnippet(videoId, undefined, durationSec);
  await writeCachedSearch(cacheKey, [hit]);
  return hit;
}

/** Durations only. Titles and channels come from search.list. */
async function fetchDurations(
  ids: string[],
  key: string
): Promise<Map<string, number>> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", key);
  const body = (await getJson(url)) as { items?: VideoItem[] };
  const durations = new Map<string, number>();
  for (const item of body.items ?? []) {
    if (!isYoutubeVideoId(item.id)) continue;
    const durationSec = parseIso8601Duration(item.contentDetails?.duration || "");
    if (durationSec == null) continue;
    durations.set(item.id, durationSec);
  }
  return durations;
}

function hitFromSnippet(
  videoId: string,
  snippet: SearchItem["snippet"] | undefined,
  durationSec: number
): YoutubeSearchHit {
  return {
    videoId,
    title: snippet?.title?.trim() || "YouTube video",
    channel: snippet?.channelTitle?.trim() || "",
    durationSec,
    thumbnailUrl:
      snippet?.thumbnails?.medium?.url ||
      snippet?.thumbnails?.high?.url ||
      youtubeThumbnailUrl(videoId),
    url: canonicalYoutubeUrl(videoId),
    suggestedRange: defaultSpeechRange(durationSec),
  };
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

async function readCachedSearch(cacheKey: string): Promise<YoutubeSearchHit[] | null> {
  const memory = searchCache.get(cacheKey);
  if (memory && Date.now() - memory.at < SEARCH_TTL_MS) return memory.value;
  try {
    const { queryOne } = await import("@/lib/turso");
    const row = await queryOne<{ payload: string; expires_at: number }>(
      `SELECT payload, expires_at FROM youtube_search_cache WHERE query_key = ? LIMIT 1`,
      [cacheKey]
    );
    if (!row) return null;
    if (Number(row.expires_at) * 1000 <= Date.now()) return null;
    const parsed = JSON.parse(row.payload) as unknown;
    if (!Array.isArray(parsed)) return null;
    const value = parsed as YoutubeSearchHit[];
    searchCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

async function writeCachedSearch(
  cacheKey: string,
  hits: YoutubeSearchHit[]
): Promise<void> {
  remember(searchCache, cacheKey, hits);
  const expiresAt = Math.floor((Date.now() + SEARCH_TTL_MS) / 1000);
  try {
    const { execute } = await import("@/lib/turso");
    await execute(
      `INSERT INTO youtube_search_cache (query_key, payload, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(query_key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
      [cacheKey, JSON.stringify(hits), expiresAt]
    );
    if (Math.random() < 0.05) {
      await execute(`DELETE FROM youtube_search_cache WHERE expires_at <= ?`, [
        Math.floor(Date.now() / 1000),
      ]).catch(() => {});
    }
  } catch {
    /* A cache miss still searches. The in-memory copy covers this instance. */
  }
}

type SearchSnippet = {
  title?: string;
  channelTitle?: string;
  liveBroadcastContent?: string;
  thumbnails?: { medium?: { url?: string }; high?: { url?: string } };
};

type SearchItem = {
  id?: { videoId?: string };
  snippet?: SearchSnippet;
};

type VideoItem = {
  id?: string;
  contentDetails?: { duration?: string };
};

type ApiBody = { items?: Array<SearchItem | VideoItem> };

export class YoutubeSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeSearchError";
  }
}

async function getJson(url: URL): Promise<ApiBody> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new YoutubeSearchError(`youtube-api-${response.status}`);
  }
  return (await response.json()) as ApiBody;
}

function remember<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  if (map.size >= MAX_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, { at: Date.now(), value });
}
