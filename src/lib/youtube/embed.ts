/** 720p is enough for the preview player. The clip itself is fetched on the worker. */
export const YOUTUBE_EMBED_QUALITY = "hd720";

export function youtubeEmbedPlayerVars(
  origin: string
): Record<string, string | number> {
  return {
    rel: 0,
    modestbranding: 1,
    playsinline: 1,
    origin,
    vq: YOUTUBE_EMBED_QUALITY,
  };
}
