/**
 * videos.list for one id. Search stays on the existing search route.
 * One call is 1 quota unit. Rejects live, upcoming, private, short, and
 * age-restricted videos before a download is queued.
 */

import { parseIso8601Duration } from "@/lib/youtube/range";
import { youtubeApiKey } from "@/lib/youtube/search";
import type { ClipErrorCode } from "@/lib/youtube/clip-policy";

export type ClipVideoFacts = {
  videoId: string;
  durationSec: number;
};

export class ClipVideoReject extends Error {
  constructor(readonly code: Extract<ClipErrorCode, "unavailable" | "restricted" | "range_unsupported">) {
    super(code);
    this.name = "ClipVideoReject";
  }
}

type VideoItem = {
  id?: string;
  snippet?: { liveBroadcastContent?: string };
  contentDetails?: {
    duration?: string;
    contentRating?: { ytRating?: string };
  };
  status?: { privacyStatus?: string };
};

export async function inspectClipVideo(
  videoId: string,
  startSec: number,
  lengthSec: number,
  key = youtubeApiKey()
): Promise<ClipVideoFacts> {
  if (!key) throw new ClipVideoReject("unavailable");
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,contentDetails,status");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", key);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new ClipVideoReject("unavailable");
  const body = (await response.json()) as { items?: VideoItem[] };
  const item = body.items?.[0];
  if (!item) throw new ClipVideoReject("unavailable");

  const live = item.snippet?.liveBroadcastContent;
  const privacy = item.status?.privacyStatus;
  const age = item.contentDetails?.contentRating?.ytRating;
  if (live === "live" || live === "upcoming" || privacy === "private" || age === "ytAgeRestricted") {
    throw new ClipVideoReject("restricted");
  }

  const durationSec = parseIso8601Duration(item.contentDetails?.duration || "");
  if (durationSec == null) throw new ClipVideoReject("unavailable");
  if (durationSec < 10) throw new ClipVideoReject("restricted");
  if (startSec < 0 || startSec + lengthSec > durationSec + 0.05) {
    throw new ClipVideoReject("range_unsupported");
  }
  return { videoId, durationSec };
}
