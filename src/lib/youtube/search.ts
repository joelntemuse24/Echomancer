/**
 * YouTube Data API v3 search. Server-only — the key never reaches the browser.
 * Results are cached briefly so typing the same query does not burn quota.
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
const VIDEO_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 80;

type CacheEntry<T> = { at: number; value: T };

const searchCache = new Map<string, CacheEntry<YoutubeSearchHit[]>>();
const videoCache = new Map<string, CacheEntry<YoutubeSearchHit | null>>();

export function clearYoutubeSearchCache(): void {
  searchCache.clear();
  videoCache.clear();
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

  const cacheKey = trimmed.toLowerCase().replace(/\s+/g, " ");
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) {
    return cached.value;
  }

  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("maxResults", "8");
  searchUrl.searchParams.set("q", trimmed);
  searchUrl.searchParams.set("videoEmbeddable", "true");
  searchUrl.searchParams.set("safeSearch", "moderate");
  searchUrl.searchParams.set("key", key);

  const search = (await getJson(searchUrl)) as { items?: SearchItem[] };
  const ids = (search.items ?? [])
    .map((item) => item.id?.videoId)
    .filter((id): id is string => isYoutubeVideoId(id));
  if (ids.length === 0) {
    remember(searchCache, cacheKey, []);
    return [];
  }

  const videos = await fetchVideoDetails(ids, key);
  const hits = videos.filter((hit) => hit.durationSec >= 10);
  remember(searchCache, cacheKey, hits);
  return hits;
}

export async function lookupYoutubeVideo(
  videoId: string,
  key = youtubeApiKey()
): Promise<YoutubeSearchHit | null> {
  if (!key || !isYoutubeVideoId(videoId)) return null;
  const cached = videoCache.get(videoId);
  if (cached && Date.now() - cached.at < VIDEO_TTL_MS) return cached.value;
  const [hit] = await fetchVideoDetails([videoId], key);
  const value = hit && hit.durationSec >= 10 ? hit : null;
  videoCache.set(videoId, { at: Date.now(), value });
  return value;
}

async function fetchVideoDetails(
  ids: string[],
  key: string
): Promise<YoutubeSearchHit[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", key);
  const body = (await getJson(url)) as { items?: VideoItem[] };
  const hits: YoutubeSearchHit[] = [];
  for (const item of body.items ?? []) {
    const videoId = item.id;
    if (!isYoutubeVideoId(videoId)) continue;
    if (item.snippet?.liveBroadcastContent === "live") continue;
    const durationSec = parseIso8601Duration(item.contentDetails?.duration || "");
    if (durationSec == null) continue;
    const title = item.snippet?.title?.trim() || "YouTube video";
    const channel = item.snippet?.channelTitle?.trim() || "";
    const thumbnail =
      item.snippet?.thumbnails?.medium?.url ||
      item.snippet?.thumbnails?.high?.url ||
      youtubeThumbnailUrl(videoId);
    hits.push({
      videoId,
      title,
      channel,
      durationSec,
      thumbnailUrl: thumbnail,
      url: canonicalYoutubeUrl(videoId),
      suggestedRange: defaultSpeechRange(durationSec),
    });
  }
  return hits;
}

type SearchItem = {
  id?: { videoId?: string };
};

type VideoItem = {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    liveBroadcastContent?: string;
    thumbnails?: { medium?: { url?: string }; high?: { url?: string } };
  };
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
