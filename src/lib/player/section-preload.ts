import { advanceAfterSection } from "@/lib/player/section-advance";

/** The next section file to fetch while the current one is still playing. */
export function nextSectionPreloadUrl(input: {
  segments:
    | Array<{ index: number; path: string; status: string }>
    | null
    | undefined;
  from: number;
  status: string | null | undefined;
}): string | null {
  const advance = advanceAfterSection(input);
  if (advance.action !== "play") return null;
  if (advance.index !== input.from + 1) return null;
  return `/api/storage/${advance.path}`;
}

export interface PreloadAudio {
  src: string;
  preload: string;
}

/**
 * Point a second audio element at the next section so the switch reuses
 * the bytes already fetched. The element is not played.
 */
export function preloadNextSection(
  audio: PreloadAudio,
  url: string | null
): void {
  if (!url) {
    if (audio.src) {
      audio.preload = "none";
      audio.src = "";
    }
    return;
  }
  if (audio.src.endsWith(url)) return;
  audio.preload = "auto";
  audio.src = url;
}
