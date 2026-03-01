import { NextRequest, NextResponse } from "next/server";
import { youtubeSearchSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parsed = youtubeSearchSchema.parse({
      q: searchParams.get("q") || "",
      maxResults: searchParams.get("maxResults") || "8",
    });

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      throw new AppError("CONFIG_MISSING", "YouTube API key not configured", 500);
    }

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", parsed.q);
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", String(parsed.maxResults));
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
      throw new AppError(
        "YOUTUBE_API_ERROR",
        data.error?.message || "YouTube search failed",
        response.status
      );
    }

    // Get video durations via videos endpoint
    const videoIds = data.items?.map((item: { id: { videoId: string } }) => item.id.videoId).join(",");
    const durations: Record<string, string> = {};

    if (videoIds) {
      const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      detailsUrl.searchParams.set("part", "contentDetails");
      detailsUrl.searchParams.set("id", videoIds);
      detailsUrl.searchParams.set("key", apiKey);

      const detailsRes = await fetch(detailsUrl.toString());
      const detailsData = await detailsRes.json();

      if (detailsRes.ok && detailsData.items) {
        for (const item of detailsData.items) {
          const dur = item.contentDetails?.duration || "";
          durations[item.id] = parseDuration(dur);
        }
      }
    }

    const videos = (data.items || []).map((item: {
      id: { videoId: string };
      snippet: {
        title: string;
        channelTitle: string;
        thumbnails: { high?: { url: string }; medium?: { url: string }; default?: { url: string } };
        publishedAt: string;
      };
    }) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail:
        item.snippet.thumbnails?.high?.url ||
        item.snippet.thumbnails?.medium?.url ||
        item.snippet.thumbnails?.default?.url ||
        "",
      duration: durations[item.id.videoId] || "",
      publishedAt: item.snippet.publishedAt,
    }));

    return NextResponse.json({ videos });
  } catch (error) {
    return handleApiError(error);
  }
}

function parseDuration(iso8601: string): string {
  const match = iso8601.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "";
  const hours = parseInt(match[1] || "0");
  const minutes = parseInt(match[2] || "0");
  const seconds = parseInt(match[3] || "0");

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
