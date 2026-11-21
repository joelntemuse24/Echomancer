/**
 * Media Session rules, kept out of React so they can be exercised without a
 * browser that has a lock screen.
 *
 * The session is what Android Chrome turns into a media notification, and
 * what a lock screen or Bluetooth button talks to. Two separate things keep
 * it alive while the tab is in the background:
 *
 *  1. The metadata and the action handlers are installed once and never
 *     removed while a book is loaded. A handler that is unset is a button
 *     that does nothing, and the notification is dropped once nothing can
 *     answer it.
 *  2. A position state is published as the playhead moves, so the scrubber
 *     in the notification shows the real time instead of a stalled one.
 *
 * Nothing here creates or destroys the media element. That is the provider's
 * job, because an element that is recreated loses the platform session.
 */

export type MediaSessionFields = {
  title: string;
  artist?: string | null;
  album?: string | null;
  artwork?: string | null;
};

/** Metadata for the platform UI. Empty optional fields are omitted, not blank. */
export function mediaSessionMetadata(fields: MediaSessionFields): {
  title: string;
  artist?: string;
  album?: string;
  artwork?: Array<{ src: string; sizes: string; type?: string }>;
} {
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const metadata: ReturnType<typeof mediaSessionMetadata> = {
    title: clean(fields.title) || "Audiobook",
  };
  const artist = clean(fields.artist);
  const album = clean(fields.album);
  if (artist) metadata.artist = artist;
  if (album) metadata.album = album;
  const artwork = clean(fields.artwork);
  if (artwork) metadata.artwork = [{ src: artwork, sizes: "512x512", type: "image/png" }];
  return metadata;
}

/**
 * `setPositionState` throws on a duration of 0, a position past the
 * duration, or a non-finite value. Those are the states a book passes
 * through while it is still loading, so they are reported as "no update"
 * rather than as a failure.
 */
export function mediaSessionPositionState(input: {
  duration: number;
  position: number;
  playbackRate: number;
}): { duration: number; position: number; playbackRate: number } | null {
  const { duration } = input;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const rate =
    Number.isFinite(input.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1;
  const raw = Number.isFinite(input.position) ? input.position : 0;
  // The platform rejects a position exactly at the duration on some builds.
  const position = Math.min(Math.max(0, raw), Math.max(0, duration - 0.05));
  return { duration, position, playbackRate: rate };
}

/**
 * A lock-screen Play after a long pause can arrive when the element has let
 * go of its resource. There are two shapes, and both look idle rather than
 * broken:
 *
 *  - Chrome drops the buffer of a parked tab and reports `NETWORK_NO_SOURCE`
 *    with no `currentSrc`.
 *  - The browser clears the resource entirely: the element keeps a stale
 *    `currentSrc`, but `src` is empty and `networkState` is `NETWORK_EMPTY`
 *    (0). `play()` then resolves while nothing is loaded — `paused` flips to
 *    false and the clock never moves, which is the "it can't resume" report.
 *
 * Either way the source has to be assigned again before `play()` means
 * anything.
 */
export function shouldReacquireSource(input: {
  hasSource: boolean;
  /** `audio.getAttribute("src")` — the assigned source, not the resolved one. */
  srcAttribute: string;
  currentSrc: string;
  networkState: number;
  errorCode: number | null;
}): boolean {
  if (!input.hasSource) return false;
  if (input.errorCode != null) return true;
  // 3 === HTMLMediaElement.NETWORK_NO_SOURCE, 0 === NETWORK_EMPTY.
  if (input.networkState === 3 || input.networkState === 0) return true;
  if (input.srcAttribute.trim() === "") return true;
  return input.currentSrc.trim() === "";
}

export type MediaSessionActionName =
  | "play"
  | "pause"
  | "seekbackward"
  | "seekforward"
  | "seekto"
  | "previoustrack"
  | "nexttrack";

export type MediaSessionActionDetails = {
  action?: MediaSessionActionName;
  seekOffset?: number;
  seekTime?: number;
  fastSeek?: boolean;
};

export type MediaSessionLike = {
  metadata: unknown;
  playbackState?: "none" | "paused" | "playing";
  setActionHandler: (
    action: MediaSessionActionName,
    handler: ((details: MediaSessionActionDetails) => void) | null
  ) => void;
  setPositionState?: (state?: {
    duration: number;
    playbackRate: number;
    position: number;
  }) => void;
};

export type MediaSessionHandlers = {
  play: () => void;
  pause: () => void;
  seekBy: (delta: number) => void;
  seekTo: (seconds: number) => void;
  previous?: (() => void) | null;
  next?: (() => void) | null;
};

/**
 * Install every action the platform can send. Returns a function that
 * removes them, which only the provider calls when the whole player is
 * torn down.
 *
 * A browser that does not know an action throws from `setActionHandler`;
 * that is expected (`seekto` is missing on some Android builds) and must not
 * stop the rest from being installed.
 */
export function installMediaSessionActions(
  session: MediaSessionLike,
  handlers: MediaSessionHandlers,
  opts: { chapterSkip: boolean; skipSeconds: number }
): void {
  const set = (
    action: MediaSessionActionName,
    handler: ((details: MediaSessionActionDetails) => void) | null
  ) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // This browser does not implement the action.
    }
  };

  set("play", () => handlers.play());
  set("pause", () => handlers.pause());
  set("seekbackward", (details) => {
    const delta = Math.abs(details.seekOffset || opts.skipSeconds);
    handlers.seekBy(-delta);
  });
  set("seekforward", (details) => {
    const delta = Math.abs(details.seekOffset || opts.skipSeconds);
    handlers.seekBy(delta);
  });
  set("seekto", (details) => {
    if (typeof details.seekTime === "number" && Number.isFinite(details.seekTime)) {
      handlers.seekTo(details.seekTime);
    }
  });
  if (opts.chapterSkip && handlers.previous) {
    set("previoustrack", () => handlers.previous?.());
  } else {
    set("previoustrack", null);
  }
  if (opts.chapterSkip && handlers.next) {
    set("nexttrack", () => handlers.next?.());
  } else {
    set("nexttrack", null);
  }
}
