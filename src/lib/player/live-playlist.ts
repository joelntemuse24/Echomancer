export const HLS_PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";

/** The rolling playlist and its segment files. These stay on the app origin. */
export function isLivePlaybackObject(storagePath: string): boolean {
  return isLivePlaylist(storagePath) || isLiveSegment(storagePath);
}

export function isLivePlaylist(storagePath: string): boolean {
  return storagePath.endsWith("/live.m3u8");
}

/** `audiobooks/<job>/live/NNNN.mp3`. Immutable once written. */
export function isLiveSegment(storagePath: string): boolean {
  return /\/live\/\d{4}\.mp3$/.test(storagePath);
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

/** Sum of the playlist's own durations. The element duration is not known yet. */
export function playlistDurationSeconds(segments: readonly { seconds: number }[]): number {
  return segments.reduce(
    (sum, segment) => sum + (Number.isFinite(segment.seconds) ? Math.max(0, segment.seconds) : 0),
    0
  );
}

/**
 * A first attach replaces whatever the element is playing. Wait until the
 * published playlist reaches the listener, so a later section is not swapped
 * for the start of a short buffer.
 */
export function liveAttachAllowed(resumeAt: number, coveredSeconds: number): boolean {
  const at = Number.isFinite(resumeAt) ? Math.max(0, resumeAt) : 0;
  const covered = Number.isFinite(coveredSeconds) ? coveredSeconds : 0;
  return at <= covered + 0.25;
}

/**
 * Book time for the live handoff. Once the element has moved, that time is
 * the section offset plus `currentTime` (a full file is already on the book
 * clock). Before it has landed, a stored part-local time uses the same
 * offset. A stored book time has no section index.
 */
export function liveAttachResumeAt(input: {
  elementSeconds: number;
  onSection: boolean;
  sectionStart: number;
  saved: { positionSeconds: number; sectionIndex: number | null } | null;
  savedSectionStart: number;
}): number {
  const element = Number.isFinite(input.elementSeconds) ? Math.max(0, input.elementSeconds) : 0;
  const start =
    input.onSection && Number.isFinite(input.sectionStart) ? Math.max(0, input.sectionStart) : 0;
  if (element > 0.5) return start + element;
  const saved = input.saved;
  if (saved && Number.isFinite(saved.positionSeconds) && saved.positionSeconds > 0.05) {
    if (saved.sectionIndex == null) return Math.max(0, saved.positionSeconds);
    const savedStart = Number.isFinite(input.savedSectionStart)
      ? Math.max(0, input.savedSectionStart)
      : 0;
    return savedStart + Math.max(0, saved.positionSeconds);
  }
  return start + element;
}

/**
 * A Parts row stays on the live element when that part is already buffered.
 * Past the buffer, the section file is loaded only after the session is released.
 */
export function chooseLivePart(input: {
  attached: boolean;
  target: number;
  covered: number;
  sectionUrl: string;
  playing: boolean;
}): { action: "seek"; at: number; play: boolean } | { action: "section"; url: string; release: boolean; play: boolean } {
  const target = Number.isFinite(input.target) ? Math.max(0, input.target) : 0;
  const covered = Number.isFinite(input.covered) ? input.covered : 0;
  if (input.attached && target <= covered + 0.05) {
    return { action: "seek", at: target, play: input.playing };
  }
  return {
    action: "section",
    url: input.sectionUrl,
    release: input.attached,
    play: input.playing,
  };
}

/**
 * How far ahead of the playhead the live element appends. The rest of a
 * generated book stays on its section file until the playhead gets there,
 * so a tap does not wait on a fetch of every earlier part.
 */
export const LIVE_AHEAD_SECONDS = 30;

/**
 * A section the listener did not choose, whose book time is past this, stays
 * on that file. A deliberate parts tap or scrub stays on the section at any
 * book time. Swapping either for a new Media Source starts at 0:00.
 */
export const LIVE_SECTION_ATTACH_MAX = 90;

/** Playlist URIs from the start through `throughSeconds`, including the one that crosses it. */
export function segmentUrisAhead(
  segments: readonly LiveSegment[],
  throughSeconds: number
): string[] {
  const need = Number.isFinite(throughSeconds) ? Math.max(0, throughSeconds) : 0;
  let sum = 0;
  const uris: string[] = [];
  for (const segment of segments) {
    uris.push(segment.uri);
    sum += Number.isFinite(segment.seconds) ? Math.max(0, segment.seconds) : 0;
    if (sum + 0.05 >= need) break;
  }
  return uris;
}

/**
 * The element is already on a section file that a live attach would replace
 * with 0:00. A short prefix still attaches when the listener did not choose
 * this file. A section they just chose stays, at any book time, and so does
 * one past the buffered end or the short prefix. An ended section stays so
 * the next file can load.
 */
export function liveSectionHold(input: {
  src: string;
  ended: boolean;
  resumeAt: number;
  /** The listener released the live element onto this section. */
  chosen?: boolean;
  /** Buffered end of the live element they left. */
  bufferedEnd?: number;
}): boolean {
  if (!input.src.includes("/sections/")) return false;
  if (input.ended) return true;
  if (input.chosen) return true;
  const at = Number.isFinite(input.resumeAt) ? input.resumeAt : 0;
  const covered = Number.isFinite(input.bufferedEnd) ? Math.max(0, input.bufferedEnd ?? 0) : 0;
  if (covered > 0 && at > covered + 0.05) return true;
  return at > LIVE_SECTION_ATTACH_MAX;
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
  /** `canPlayType("application/vnd.apple.mpegurl")` was non-empty. Safari. */
  nativeHls: boolean;
}): LiveTransport | null {
  if (support.managed && support.managedMpeg) return "mms";
  if (support.mediaSource && support.mediaSourceMpeg) return "mse";
  // Safari plays an MPEG playlist in <audio>. Chrome and Firefox report an
  // empty canPlayType, and assigning live.m3u8 there replaces the section
  // file with a source that stays at 0:00.
  if (support.nativeHls) return "hls";
  return null;
}

/** An open live session stays on its source when the book becomes ready. */
export function keepLiveSource(attached: boolean): boolean {
  return attached;
}

export interface LiveReadyStay {
  action: "stay";
}

export interface LiveReadyHandoff {
  action: "handoff";
  url: string;
  at: number;
  play: boolean;
}

/**
 * A Media Source keeps the bytes it already appended. Native HLS reloads a
 * playlist when ENDLIST arrives, which restarts at the first segment, so
 * that transport moves once onto the finished file at the same playhead.
 */
/**
 * Where to land on full.mp3. Native HLS applies ENDLIST on its own reload
 * and can already be at 0:00 and paused, so a backward jump uses the last
 * position confirmed before that reload and keeps playing unless the
 * listener paused.
 */
export function liveHandoffPlayhead(input: {
  currentTime: number;
  confirmedAt: number | null | undefined;
  playing: boolean;
  listenerPaused: boolean;
}): { at: number; play: boolean } {
  const current =
    Number.isFinite(input.currentTime) && input.currentTime > 0 ? input.currentTime : 0;
  const confirmed =
    typeof input.confirmedAt === "number" &&
    Number.isFinite(input.confirmedAt) &&
    input.confirmedAt > 0
      ? input.confirmedAt
      : 0;
  const reset = confirmed > 0 && current + 0.5 < confirmed;
  return {
    at: reset ? confirmed : Math.max(current, confirmed),
    play: !input.listenerPaused && (input.playing || reset),
  };
}

export function liveReadyTransition(input: {
  transport: LiveTransport | null;
  complete: boolean;
  ready: boolean;
  fullUrl: string | null;
  currentSrc?: string | null;
  currentTime: number;
  confirmedAt?: number | null;
  playing: boolean;
  listenerPaused?: boolean;
}): LiveReadyStay | LiveReadyHandoff {
  if (input.transport !== "hls" || !input.complete || !input.ready || !input.fullUrl) {
    return { action: "stay" };
  }
  const current = input.currentSrc?.split("?")[0] ?? "";
  const next = input.fullUrl.split("?")[0];
  if (current && current === next) return { action: "stay" };
  const head = liveHandoffPlayhead({
    currentTime: input.currentTime,
    confirmedAt: input.confirmedAt,
    playing: input.playing,
    listenerPaused: input.listenerPaused === true,
  });
  return { action: "handoff", url: input.fullUrl, at: head.at, play: head.play };
}

/**
 * A chapter seek stays on the live element when that time is already
 * buffered. Past the buffer, the finished file is the one source that has it.
 */
export function liveChapterSeek(input: {
  target: number;
  covered: number;
  fullUrl: string | null;
  playing: boolean;
}): { action: "seek"; at: number } | LiveReadyHandoff | null {
  if (!Number.isFinite(input.target) || input.target < 0 || !input.fullUrl) return null;
  const covered = Number.isFinite(input.covered) && input.covered > 0 ? input.covered : 0;
  if (input.target <= covered + 0.05) return { action: "seek", at: input.target };
  return { action: "handoff", url: input.fullUrl, at: input.target, play: input.playing };
}

/**
 * The playhead ran off the end of the bytes appended so far. Resume when
 * the next segment arrives. A pause the listener chose, and the end of a
 * finished playlist, stay paused.
 */
export function shouldResumeLive(input: {
  listenerPaused: boolean;
  complete: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  covered: number;
}): boolean {
  if (input.listenerPaused || input.complete) return false;
  if (!input.paused && !input.ended) return false;
  const covered = Number.isFinite(input.covered) ? input.covered : 0;
  const at = Number.isFinite(input.currentTime) ? input.currentTime : 0;
  // A book the listener has not started stays paused.
  if (!(at > 0.5)) return false;
  if (covered > at + 0.05) return true;
  return input.paused && covered > 0 && at >= covered - 0.4;
}
