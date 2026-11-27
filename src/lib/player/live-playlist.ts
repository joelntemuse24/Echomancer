export const HLS_PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";

/** The rolling playlist and its segment files. These stay on the app origin. */
export function isLivePlaybackObject(storagePath: string): boolean {
  return storagePath.endsWith("/live.m3u8") || /\/live\/\d{4}\.mp3$/.test(storagePath);
}

export type LiveSegment = { uri: string; seconds: number };

export type LivePlaylist = {
  segments: LiveSegment[];
  bytes: number | null;
  complete: boolean;
};

/** EVENT playlist. Segments are immutable; the file itself is rewritten. */
export function hlsEventPlaylist(
  segments: readonly LiveSegment[],
  bytes: number,
  complete: boolean
): string {
  const target = Math.max(1, ...segments.map((segment) => Math.ceil(segment.seconds)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    `#ECH-BYTES:${Math.max(0, Math.floor(bytes))}`,
  ];
  for (const segment of segments) {
    lines.push(`#EXTINF:${segment.seconds.toFixed(3)},`, segment.uri);
  }
  if (complete) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

export function readHlsPlaylist(text: string): LivePlaylist {
  if (!text.includes("#EXTM3U")) return { segments: [], bytes: null, complete: false };
  const segments: LiveSegment[] = [];
  let bytes: number | null = null;
  let pending: number | null = null;
  let complete = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#ECH-BYTES:")) {
      const value = Number(line.slice("#ECH-BYTES:".length));
      bytes = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      complete = true;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const value = Number(line.slice("#EXTINF:".length).split(",")[0]);
      pending = Number.isFinite(value) ? value : 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    segments.push({ uri: line, seconds: pending ?? 0 });
    pending = null;
  }
  return { segments, bytes, complete };
}

/**
 * New segments, in playlist order. A playlist that does not start with the
 * segments already appended is refused so a rewrite cannot be played.
 */
export function pendingSegmentUris(
  already: readonly string[],
  playlist: readonly string[]
): string[] {
  for (let index = 0; index < already.length; index++) {
    if (playlist[index] !== already[index]) return [];
  }
  return playlist.slice(already.length);
}

/** Seek only once the buffered media reaches the saved position. */
export function seekTargetIfCovered(target: number, coveredSeconds: number): number | null {
  if (!(target > 0.05)) return null;
  if (!(coveredSeconds + 0.05 >= target)) return null;
  return target;
}

/** Seconds of already-played media to leave in the SourceBuffer. */
export const LIVE_BACK_BUFFER_SECONDS = 30;

/**
 * End of the range to remove when the buffer is full. Keeps a back-buffer
 * behind the playhead, or one second when the playhead is still inside it.
 */
export function evictionEnd(
  currentTime: number,
  backBuffer = LIVE_BACK_BUFFER_SECONDS
): number | null {
  if (!(currentTime > 1)) return null;
  const kept = currentTime - backBuffer;
  if (kept > 0.25) return kept;
  const tight = currentTime - 1;
  return tight > 0.25 ? tight : null;
}

export type LiveTransport = "mms" | "mse" | "hls";

export function chooseLiveTransport(support: {
  managed: boolean;
  managedMpeg: boolean;
  mediaSource: boolean;
  mediaSourceMpeg: boolean;
}): LiveTransport {
  if (support.managed && support.managedMpeg) return "mms";
  if (support.mediaSource && support.mediaSourceMpeg) return "mse";
  return "hls";
}

/** An open live session stays on its source when the book becomes ready. */
export function keepLiveSource(attached: boolean): boolean {
  return attached;
}
