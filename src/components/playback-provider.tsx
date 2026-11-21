"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Pause, Play, X } from "lucide-react";
import { playerIdFromPathname } from "@/lib/nav/player-path";
import { formatPlayClock, SKIP_SECONDS } from "@/lib/player/seek";
import { assignPlaybackRate } from "@/lib/player/playback-speed";
import { resumeAudioGraphs } from "@/lib/player/audio-graph";
import {
  installMediaSessionActions,
  mediaSessionMetadata,
  mediaSessionPositionState,
  shouldReacquireSource,
  type MediaSessionActionName,
  type MediaSessionLike,
} from "@/lib/player/media-session";
import { usePlaybackSpeed } from "@/hooks/use-playback-speed";

/** The card art the platform notification shows. */
export const PLAYBACK_ARTWORK = "/icon-512.png";

/** Same level the audio helper applies; kept here for the one element. */
const ELEMENT_VOLUME = 0.75;

/**
 * What the player page reports each render.
 *
 * `position` and `duration` are on the book clock (sections add up), which is
 * what the platform's scrubber shows. `play`/`pause`/`seek`/`skip`/`chapter`
 * are the page's own implementations, so recovery, the resume position, a
 * chapter skip inside a book made of parts, and the ETA all behave exactly as
 * the on-screen transport does while the page is mounted.
 */
export type PlaybackReport = {
  /** False for a failed or cancelled book: no session, no mini player. */
  active: boolean;
  jobId: string | null;
  title: string;
  artist?: string | null;
  album?: string | null;
  duration: number;
  position: number;
  /**
   * Where this element's clock 0 sits on the book clock. A part file starts
   * at its part's offset; a finished book is 0. The page computes it from
   * the part spans, so a drag on the scrubber cannot move it.
   */
  elementOffset: number;
  playing: boolean;
  seekable: boolean;
  play: (() => void) | null;
  pause: (() => void) | null;
  seek: ((bookSeconds: number) => void) | null;
  skip: ((deltaSeconds: number) => void) | null;
  chapter: ((direction: "previous" | "next") => void) | null;
};

type PlaybackShell = {
  /** The one element. Never recreated, never unmounted, never cleared on pause. */
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Point the element at a source for this book. Same URL is a no-op. */
  setSource: (src: string, jobId: string) => void;
  /** Release the source, but only when it belongs to `jobId`. */
  releaseForJob: (jobId: string) => void;
  /** Release whatever is loaded (the mini player's close button). */
  release: () => void;
  /** Report the current book for the media session and the mini player. */
  reportSession: (report: PlaybackReport) => void;
  /** The page is going away; the element and the session stay. */
  detachSession: () => void;
};

const PlaybackContext = createContext<PlaybackShell | null>(null);

/**
 * The few fields the mini strip renders that change rarely. The playhead is
 * deliberately not here: it changes at 4 Hz and would re-render every page
 * inside the provider. {@link MiniPlayer} reads the element itself instead.
 */
type NowPlaying = {
  jobId: string | null;
  title: string;
  voice: string | null;
  playing: boolean;
  canSeek: boolean;
  /** The listener has actually heard this book; the strip waits for that. */
  started: boolean;
};

const EMPTY_NOW_PLAYING: NowPlaying = {
  jobId: null,
  title: "",
  voice: null,
  playing: false,
  canSeek: false,
  started: false,
};

/**
 * The site-wide audio shell.
 *
 * One `<audio>` element lives here, in the root layout, so a route change
 * cannot unmount it. The player page points it at a source and reports what
 * is playing; the shell keeps the Media Session (metadata, transport, and
 * position state) installed and renders the mini player once the page is
 * gone.
 *
 * Deliberate rules, because Android Chrome ends the media notification when
 * any of them is broken:
 *
 *  - `src` is never cleared on pause, `visibilitychange`, or `pagehide`.
 *    Only an explicit close, a different book, or a book that may not play
 *    clears it.
 *  - The element is never recreated and its listeners are attached once.
 *  - Metadata and action handlers are not removed when the page unmounts.
 *  - The element is not routed through Web Audio, so a suspended graph cannot
 *    mute it; any graph the app does open is resumed on demand.
 *
 * Book clock after the page is gone: the report carries
 * `position - element.currentTime` as an offset, so the notification's
 * scrubber still lands on the right minute of a book made of parts. Walking
 * to the next part needs the page's own handler, so a part book stops at the
 * end of the part it is on once the page has gone.
 */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { speed } = usePlaybackSpeed();

  const srcRef = useRef<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const reportRef = useRef<PlaybackReport | null>(null);
  /** book clock minus element clock, so a part book still seeks correctly. */
  const bookOffsetRef = useRef(0);
  const lastPositionRef = useRef(0);
  const metadataKeyRef = useRef("");
  const stateKeyRef = useRef("");
  const positionKeyRef = useRef("");

  const [identity, setIdentity] = useState<NowPlaying>(EMPTY_NOW_PLAYING);
  const [dismissed, setDismissed] = useState(false);

  const mediaSession = useCallback((): MediaSessionLike | null => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return null;
    return navigator.mediaSession as unknown as MediaSessionLike;
  }, []);

  /** Book-clock position for the platform UI and the mini strip. */
  const bookClockNow = useCallback(() => {
    const audio = audioRef.current;
    const element = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    return Math.max(0, element + bookOffsetRef.current);
  }, []);

  /**
   * A source the platform may have dropped while paused. Chrome frees the
   * buffer of a background tab, so the element can report NO_SOURCE with an
   * empty `currentSrc`; `play()` alone can never recover that. The source is
   * re-assigned (the same element, so the session survives) and the saved
   * position is restored before playing.
   */
  const reacquire = useCallback(async () => {
    const audio = audioRef.current;
    const src = srcRef.current;
    if (!audio || !src) return;
    const needs = shouldReacquireSource({
      hasSource: true,
      srcAttribute: audio.getAttribute("src") ?? "",
      currentSrc: audio.currentSrc || audio.src || "",
      networkState: audio.networkState,
      errorCode: audio.error?.code ?? null,
    });
    if (!needs) return;
    const at = lastPositionRef.current;

    const waitFor = (event: "loadedmetadata" | "seeked", timeoutMs: number) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          audio.removeEventListener(event, done);
          audio.removeEventListener("error", done);
          resolve();
        };
        audio.addEventListener(event, done);
        audio.addEventListener("error", done);
        // A wake that never lands must not hold the lock-screen button.
        window.setTimeout(done, timeoutMs);
      });

    const loaded = waitFor("loadedmetadata", 10_000);
    // Re-assigning `src` on this element keeps the platform session; a new
    // element would end it.
    audio.src = src;
    audio.load();
    await loaded;

    if (at > 0.5) {
      const seekable = Number.isFinite(audio.duration) ? audio.duration : 0;
      const target = Math.max(0, Math.min(at - bookOffsetRef.current, Math.max(0, seekable - 0.05)));
      if (target > 0.05) {
        const sought = waitFor("seeked", 5_000);
        try {
          audio.currentTime = target;
        } catch {
          // Not seekable yet; the element starts where it was told to.
        }
        // Play only once the seek has landed, or the first second of the
        // book plays before the restore takes effect.
        await sought;
      }
    }
  }, []);

  /** Play from the shell. Uses the page's own start path while it is mounted. */
  const playFromShell = useCallback(() => {
    void resumeAudioGraphs();
    const report = reportRef.current;
    if (report?.active && report.play) {
      // The page's transport owns recovery, the resume position, and the ETA.
      report.play();
      return;
    }
    const audio = audioRef.current;
    if (!audio || !audio.paused) return;
    void reacquire()
      .then(() => audio.play())
      .catch(() => {
        // A lock-screen tap is a user gesture; a refusal here is final.
      });
  }, [reacquire]);

  const pauseFromShell = useCallback(() => {
    // The page's pause path also records the position and stops its watchdog.
    const report = reportRef.current;
    if (report?.active && report.pause) {
      report.pause();
      return;
    }
    audioRef.current?.pause();
  }, []);

  const seekBookSeconds = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    const report = reportRef.current;
    if (report?.active && report.seek) {
      report.seek(seconds);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const element = Math.max(0, seconds - bookOffsetRef.current);
    const max =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.max(0, audio.duration - 0.05)
        : element;
    audio.currentTime = Math.min(element, max);
  }, []);

  const skipBy = useCallback(
    (delta: number) => {
      const report = reportRef.current;
      if (report?.active && report.skip) {
        report.skip(delta);
        return;
      }
      seekBookSeconds(bookClockNow() + delta);
    },
    [bookClockNow, seekBookSeconds]
  );

  const chapter = useCallback((direction: "previous" | "next") => {
    const report = reportRef.current;
    if (!report?.active || !report.chapter) return;
    report.chapter(direction);
  }, []);

  const dispatch = useCallback(
    (action: MediaSessionActionName, details: { seekOffset?: number; seekTime?: number }) => {
      switch (action) {
        case "play":
          playFromShell();
          return;
        case "pause":
          pauseFromShell();
          return;
        case "seekbackward":
          skipBy(-Math.abs(details.seekOffset || SKIP_SECONDS));
          return;
        case "seekforward":
          skipBy(Math.abs(details.seekOffset || SKIP_SECONDS));
          return;
        case "seekto":
          if (typeof details.seekTime === "number") seekBookSeconds(details.seekTime);
          return;
        case "previoustrack":
          chapter("previous");
          return;
        case "nexttrack":
          chapter("next");
          return;
        default:
          return;
      }
    },
    [chapter, pauseFromShell, playFromShell, seekBookSeconds, skipBy]
  );

  /** Publish playbackState and the scrubber position. No React state. */
  const publishSession = useCallback(
    (position: number, duration: number, playing: boolean) => {
      const media = mediaSession();
      if (!media) return;
      const playbackState = playing ? "playing" : "paused";
      if (playbackState !== stateKeyRef.current) {
        stateKeyRef.current = playbackState;
        media.playbackState = playbackState;
      }
      const state = mediaSessionPositionState({
        duration,
        position,
        playbackRate: speed,
      });
      if (!state) return;
      const key = `${state.duration}|${state.position}|${state.playbackRate}`;
      if (key === positionKeyRef.current) return;
      positionKeyRef.current = key;
      try {
        media.setPositionState?.(state);
      } catch {
        // A browser that rejects this state can take the next one.
      }
    },
    [mediaSession, speed]
  );

  /**
   * Install the platform handlers once. They read the live report, so they
   * keep working across books and after the player page unmounts. Nothing is
   * unset until this provider itself goes away.
   */
  useEffect(() => {
    const media = mediaSession();
    if (!media) return;
    installMediaSessionActions(
      media,
      {
        play: () => dispatch("play", {}),
        pause: () => dispatch("pause", {}),
        seekBy: (delta) =>
          dispatch(delta < 0 ? "seekbackward" : "seekforward", { seekOffset: Math.abs(delta) }),
        seekTo: (seconds) => dispatch("seekto", { seekTime: seconds }),
        previous: () => dispatch("previoustrack", {}),
        next: () => dispatch("nexttrack", {}),
      },
      { chapterSkip: true, skipSeconds: SKIP_SECONDS }
    );
    return () => {
      installMediaSessionActions(
        media,
        {
          play: () => dispatch("play", {}),
          pause: () => dispatch("pause", {}),
          seekBy: () => {},
          seekTo: () => {},
        },
        { chapterSkip: false, skipSeconds: SKIP_SECONDS }
      );
      media.metadata = null;
      media.playbackState = "none";
    };
  }, [dispatch, mediaSession]);

  // Element listeners, attached once to the one element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.volume = ELEMENT_VOLUME;
    } catch {
      /* read-only on some platforms */
    }

    // With the page mounted, `reportSession` owns the position (book clock).
    // Without it, this is the only place left that can move the scrubber.
    const publish = () => {
      const element = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const elementDuration =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const report = reportRef.current;
      const offset = bookOffsetRef.current;
      const position = report?.active ? report.position : element + offset;
      const duration =
        report?.active && report.duration > 0 ? report.duration : elementDuration + offset;
      const playing = !audio.paused && !audio.ended;
      if (position > 0.5) lastPositionRef.current = position;
      publishSession(position, duration, playing);
      setIdentity((prev) => {
        // A book the listener has not started has no strip to come back to,
        // so opening a player and walking away leaves the page as it was.
        const started = prev.started || playing;
        if (
          prev.playing === playing &&
          prev.canSeek === (duration > 0) &&
          prev.started === started
        ) {
          return prev;
        }
        return { ...prev, playing, canSeek: duration > 0, started };
      });
    };

    audio.addEventListener("play", publish);
    audio.addEventListener("playing", publish);
    audio.addEventListener("pause", publish);
    audio.addEventListener("timeupdate", publish);
    audio.addEventListener("durationchange", publish);
    audio.addEventListener("loadedmetadata", publish);
    audio.addEventListener("ended", publish);
    return () => {
      audio.removeEventListener("play", publish);
      audio.removeEventListener("playing", publish);
      audio.removeEventListener("pause", publish);
      audio.removeEventListener("timeupdate", publish);
      audio.removeEventListener("durationchange", publish);
      audio.removeEventListener("loadedmetadata", publish);
      audio.removeEventListener("ended", publish);
    };
    // `publishSession` already reads the current rate through its own deps;
    // re-attaching on every rate change would drop a `timeupdate`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    assignPlaybackRate(audio, speed);
  }, [speed]);

  const setSource = useCallback((src: string, jobId: string) => {
    const audio = audioRef.current;
    srcRef.current = src;
    jobIdRef.current = jobId;
    setDismissed(false);
    if (audio && audio.getAttribute("src") !== src) {
      // A different source is a new book: the old clock is not this book's.
      bookOffsetRef.current = 0;
      lastPositionRef.current = 0;
      audio.src = src;
    }
    setIdentity((prev) =>
      prev.jobId === jobId ? prev : { ...prev, jobId, started: false }
    );
  }, []);

  const release = useCallback(() => {
    const audio = audioRef.current;
    srcRef.current = null;
    jobIdRef.current = null;
    reportRef.current = null;
    bookOffsetRef.current = 0;
    lastPositionRef.current = 0;
    metadataKeyRef.current = "";
    stateKeyRef.current = "";
    positionKeyRef.current = "";
    const media = mediaSession();
    if (media) {
      media.metadata = null;
      media.playbackState = "none";
    }
    if (audio) {
      // The one place a source is released on purpose: an explicit close or
      // a book that may not play. Never on pause or a hidden tab.
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setIdentity(EMPTY_NOW_PLAYING);
  }, [mediaSession]);

  const releaseForJob = useCallback(
    (jobId: string) => {
      if (jobIdRef.current !== jobId) return;
      release();
    },
    [release]
  );

  const reportSession = useCallback(
    (report: PlaybackReport) => {
      reportRef.current = report.active && report.jobId ? report : null;
      if (!report.active || !report.jobId) return;

      bookOffsetRef.current = Math.max(0, report.elementOffset);
      if (report.position > 0.5) lastPositionRef.current = report.position;

      const media = mediaSession();
      const metadata = mediaSessionMetadata({
        title: report.title,
        artist: report.artist,
        album: report.album,
        artwork: PLAYBACK_ARTWORK,
      });
      const metadataKey = `${metadata.title}|${metadata.artist ?? ""}|${metadata.album ?? ""}`;
      if (
        media &&
        typeof MediaMetadata === "function" &&
        metadataKey !== metadataKeyRef.current &&
        jobIdRef.current === report.jobId
      ) {
        metadataKeyRef.current = metadataKey;
        media.metadata = new MediaMetadata(metadata);
      }

      publishSession(report.position, report.duration, report.playing);

      setIdentity((prev) => {
        const voice = metadata.artist ?? null;
        if (
          prev.jobId === report.jobId &&
          prev.title === metadata.title &&
          prev.voice === voice &&
          prev.playing === report.playing &&
          prev.canSeek === report.seekable
        ) {
          return prev;
        }
        return {
          jobId: report.jobId,
          title: metadata.title,
          voice,
          playing: report.playing,
          canSeek: report.seekable,
          started: prev.started || report.playing,
        };
      });
    },
    [mediaSession, publishSession]
  );

  const detachSession = useCallback(() => {
    reportRef.current = null;
  }, []);

  /** Stable identity: the mini strip re-subscribes only if this changes. */
  const readBookOffset = useCallback(() => bookOffsetRef.current, []);

  const closeMiniPlayer = useCallback(() => {
    setDismissed(true);
    release();
  }, [release]);

  const value = useMemo<PlaybackShell>(
    () => ({ audioRef, setSource, releaseForJob, release, reportSession, detachSession }),
    [audioRef, release, releaseForJob, reportSession, detachSession, setSource]
  );

  const routeJobId = playerIdFromPathname(pathname);
  // The mobile tab bar belongs to the dashboard chrome only. Everywhere else
  // the strip sits on the bottom edge, so it does not float above a gap.
  const aboveTabBar = pathname?.startsWith("/dashboard") ?? false;
  const showMini =
    !dismissed &&
    identity.started &&
    identity.jobId != null &&
    identity.title !== "" &&
    routeJobId !== identity.jobId;

  return (
    <PlaybackContext.Provider value={value}>
      {/* The one element. Rendered once, never keyed, never conditional. */}
      <audio ref={audioRef} preload="auto" />
      {children}
      {showMini ? (
        <MiniPlayer
          audioRef={audioRef}
          jobId={identity.jobId!}
          title={identity.title}
          voice={identity.voice}
          playing={identity.playing}
          canSeek={identity.canSeek}
          aboveTabBar={aboveTabBar}
          bookOffset={readBookOffset}
          onToggle={() => {
            if (identity.playing) pauseFromShell();
            else playFromShell();
          }}
          onSeek={(seconds) => seekBookSeconds(seconds)}
          onClose={closeMiniPlayer}
        />
      ) : null}
    </PlaybackContext.Provider>
  );
}

/**
 * The slim bottom strip.
 *
 * It is a labelled landmark, its transport buttons are real buttons with
 * names, and the progress control is a native range input so a keyboard and
 * a screen reader can both move it. It reads the playhead from the element
 * itself, so a 4 Hz clock never re-renders the page under it. It carries its
 * own height as a spacer and sits above the mobile tab bar, so it never
 * covers page content.
 */
function MiniPlayer({
  audioRef,
  jobId,
  title,
  voice,
  playing,
  canSeek,
  aboveTabBar,
  bookOffset,
  onToggle,
  onSeek,
  onClose,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  jobId: string;
  title: string;
  voice: string | null;
  playing: boolean;
  canSeek: boolean;
  /** Mobile only: clear the dashboard tab bar instead of the bottom edge. */
  aboveTabBar: boolean;
  bookOffset: () => number;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onClose: () => void;
}) {
  const [clock, setClock] = useState({ position: 0, duration: 0 });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const read = () => {
      const offset = bookOffset();
      const position = (Number.isFinite(audio.currentTime) ? audio.currentTime : 0) + offset;
      const local = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const duration = local + offset;
      setClock((prev) =>
        Math.abs(prev.position - position) < 0.4 && prev.duration === duration
          ? prev
          : { position, duration }
      );
    };
    read();
    audio.addEventListener("timeupdate", read);
    audio.addEventListener("loadedmetadata", read);
    audio.addEventListener("durationchange", read);
    return () => {
      audio.removeEventListener("timeupdate", read);
      audio.removeEventListener("loadedmetadata", read);
      audio.removeEventListener("durationchange", read);
    };
  }, [audioRef, bookOffset]);

  const max = Math.max(1, Math.floor(clock.duration));
  const value = Math.min(Math.max(0, Math.floor(clock.position)), max);

  return (
    <>
      <div aria-hidden="true" className="h-20 md:h-16" />
      <section
        aria-label="Now playing"
        data-testid="mini-player"
        className={`fixed inset-x-0 z-40 border-t border-border/60 bg-background/95 backdrop-blur md:bottom-0 ${
          aboveTabBar ? "bottom-[4.25rem]" : "bottom-0"
        }`}
      >
        <div className="container mx-auto flex items-center gap-3 px-4 py-2 md:py-2.5">
          <button
            type="button"
            onClick={onToggle}
            aria-label={playing ? "Pause" : "Play"}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-foreground transition-opacity hover:opacity-70"
          >
            {playing ? (
              <Pause aria-hidden="true" className="h-5 w-5" strokeWidth={1.5} />
            ) : (
              <Play aria-hidden="true" className="ml-0.5 h-5 w-5" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <Link
                href={`/dashboard/player/${encodeURIComponent(jobId)}`}
                className="min-w-0 flex-1 truncate font-serif text-sm text-foreground hover:opacity-80"
              >
                {title}
              </Link>
              {voice ? (
                <span className="hidden shrink-0 truncate text-[11px] text-muted-foreground sm:inline">
                  {voice}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {formatPlayClock(clock.position)}
              </span>
              <input
                type="range"
                aria-label="Seek"
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={value}
                aria-valuetext={`${formatPlayClock(clock.position)} of ${formatPlayClock(clock.duration)}`}
                min={0}
                max={max}
                step={1}
                value={value}
                disabled={!canSeek}
                onChange={(event) => onSeek(Number(event.target.value))}
                className="mini-seek h-1 w-full min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-foreground disabled:cursor-default disabled:opacity-40"
              />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {formatPlayClock(clock.duration)}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close player"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </section>
    </>
  );
}

/** The shell. A page outside the root layout is a bug, and it says so. */
export function usePlayback(): PlaybackShell {
  const shell = useContext(PlaybackContext);
  if (!shell) throw new Error("usePlayback must be used inside PlaybackProvider");
  return shell;
}
