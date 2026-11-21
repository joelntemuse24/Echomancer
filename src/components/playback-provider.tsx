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
import { browserPrefStore } from "@/lib/player/player-prefs";
import { saveShellResume } from "@/lib/player/shell-resume";
import {
  placeOnTimeline,
  readStoredResume,
  type SectionSpan,
} from "@/lib/player/playback-position";
import { resumeAudioGraphs } from "@/lib/player/audio-graph";
import { elementIsPlaying } from "@/lib/player/element-playback";
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
 * How often the shell stores the playhead while the player page is unmounted.
 * The page's own clock is 5s (`RESUME_SAVE_INTERVAL_MS`); this matches it so a
 * tab closed from the mini player loses no more than a page close would.
 */
const SHELL_RESUME_INTERVAL_MS = 5000;

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
  /**
   * Every part of this book, on the book clock. A book made of parts has one
   * source per part, so the shell needs the spans to move between them once
   * the player page is gone — otherwise the mini player's scrubber can only
   * land inside the part the element happens to hold.
   */
  parts: readonly SectionSpan[];
  seekable: boolean;
  play: (() => void) | null;
  pause: (() => void) | null;
  seek: ((bookSeconds: number) => void) | null;
  skip: ((deltaSeconds: number) => void) | null;
  chapter: ((direction: "previous" | "next") => void) | null;
  /** The book's assembled file, when it has one, for a part-boundary handoff. */
  fullUrl?: string | null;
};

type PlaybackShell = {
  /** The one element. Never recreated, never unmounted, never cleared on pause. */
  audioRef: RefObject<HTMLAudioElement | null>;
  /**
   * Whether that element is playing right now, from its own events.
   *
   * This is the page's only source for the transport icon. A page that kept
   * its own copy started from "paused" on every mount, and a book that never
   * stopped fires no `play` event — so re-entering the player showed Play over
   * playing audio and the tap was a no-op.
   */
  playing: boolean;
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
  /** The book's part list as the page last reported it. Empty for a single file. */
  const partsRef = useRef<readonly SectionSpan[]>([]);
  /** Guards the one part hop a shell makes when a part ends. */
  const handingOffRef = useRef(false);
  /** The rate the platform should report. Kept in a ref for the once-only listeners. */
  const speedRef = useRef(speed);
  speedRef.current = speed;

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
    // Whatever the element was last pointed at is the URL that worked; a
    // cache-busting `?r=n` added after a media error is part of that.
    const src = audio?.getAttribute("src") || srcRef.current;
    if (!audio || !src) return;
    const element = audio;
    const needs = shouldReacquireSource({
      hasSource: true,
      srcAttribute: audio.getAttribute("src") ?? "",
      currentSrc: audio.currentSrc || audio.src || "",
      networkState: audio.networkState,
      errorCode: audio.error?.code ?? null,
    });
    if (!needs) return;
    // The live playhead is the truth if this element still holds one; the
    // stored copy is only the fallback for an element that was actually
    // cleared (which is exactly the case `shouldReacquireSource` matched).
    // Both sides are on the book clock; the offset is applied once, below.
    const stored = jobIdRef.current
      ? readStoredResume(browserPrefStore(), jobIdRef.current)
      : null;
    const at = Math.max(
      lastPositionRef.current,
      stored?.positionSeconds ?? 0
    );
    const offset = bookOffsetRef.current;

    const waitFor = (event: "loadedmetadata" | "seeked", timeoutMs: number) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const timer = window.setTimeout(done, timeoutMs);
        function done() {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          element.removeEventListener(event, done);
          element.removeEventListener("error", done);
          resolve();
        }
        element.addEventListener(event, done);
        element.addEventListener("error", done);
      });

    const loaded = waitFor("loadedmetadata", 10_000);
    // Re-assigning `src` on this element keeps the platform session; a new
    // element would end it.
    audio.src = src;
    audio.load();
    await loaded;

    // The stored value is a book clock; the element wants its own clock.
    const elementTarget = at - offset;
    if (elementTarget > 0.5) {
      const seekable = Number.isFinite(audio.duration) ? audio.duration : 0;
      const target = Math.max(0, Math.min(elementTarget, Math.max(0, seekable - 0.05)));
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

  /**
   * Move the element to a book-clock target with no page mounted.
   *
   * A book made of parts is one source per part, so a target outside the
   * element's own part needs a new `src`. The part list the page last
   * reported is what makes that possible; without it the old code clamped the
   * target into the current part, and dragging the mini player's scrubber
   * backwards silently jumped to 0:00 of the part that happened to be loaded
   * instead of the earlier one.
   *
   * Only the source changes; the element, the session, and the metadata stay,
   * so the platform notification survives the part change exactly as it
   * survives a pause.
   */
  const moveElementToBookSeconds = useCallback((seconds: number, autoplay: boolean) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.max(0, seconds);
    const parts = partsRef.current;
    const placed = parts.length > 0 ? placeOnTimeline({ bookSeconds: target, spans: parts }) : null;

    // Same part, or a book with no part list: the element can seek itself.
    const currentPart = parts.find(
      (span) => Math.abs(span.startSeconds - bookOffsetRef.current) < 0.25
    )?.index;
    if (!placed || placed.sectionIndex === currentPart) {
      const element = Math.max(0, target - bookOffsetRef.current);
      const max =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.max(0, audio.duration - 0.05)
          : element;
      if (element > max + 0.25) return;
      audio.currentTime = Math.min(element, max);
      return;
    }

    const part = parts.find((span) => span.index === placed.sectionIndex);
    if (!part?.url) return;
    // The element's clock restarts with the new file; the book offset moves
    // with the part it now holds.
    bookOffsetRef.current = part.startSeconds;
    lastPositionRef.current = target;
    audio.src = part.url;
    audio.load();
    const applySeek = () => {
      try {
        audio.currentTime = placed.localSeconds;
      } catch {
        // Not seekable yet; the element starts where it was told.
      }
    };
    // Metadata may already be known (a cached object, or an element that
    // never left HAVE_METADATA), in which case this event never fires.
    if (audio.readyState >= 1) applySeek();
    else audio.addEventListener("loadedmetadata", applySeek, { once: true });
    if (autoplay) {
      void audio.play().catch(() => {
        // A lock-screen tap is a user gesture; a refusal here is final.
      });
    }
  }, []);

  const seekBookSeconds = useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds)) return;
      const report = reportRef.current;
      if (report?.active && report.seek) {
        report.seek(seconds);
        return;
      }
      // A scrub or a lock-screen seek is a move inside a book that was
      // playing; changing parts must not quietly stop it.
      const playing = Boolean(audioRef.current && !audioRef.current.paused);
      moveElementToBookSeconds(seconds, playing);
    },
    [moveElementToBookSeconds]
  );

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

  /**
   * Publish playbackState and the scrubber position. No React state.
   *
   * The rate comes from a ref, not the closure: the element listeners are
   * attached once (a re-attach drops a `timeupdate`), so a captured `speed`
   * would pin the platform's scrubber to the rate the page first rendered
   * with — the notification then reported 1× while the book played at 1.45×.
   */
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
        playbackRate: speedRef.current,
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
    [mediaSession]
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

    /**
     * Keep the stored position moving while the player page is gone.
     *
     * The page owns the paced save while it is mounted: it writes the local row
     * *and* the server row, and it knows which part the element is on. Once the
     * listener walks to Library, only this clock is left, and without it the
     * stored position froze at the moment of navigation — closing the browser
     * from the mini player reopened the book at that stale spot.
     *
     * This writes only the local row, and only while the element is actually
     * playing, so a paused tab does not creep forward. `updatedAt` moves with
     * it, which is what makes `preferResume` pick it over an older server copy.
     */
    let lastSavedAt = 0;
    const saveResume = () => {
      if (reportRef.current) return; // the page owns the save while mounted
      const jobId = jobIdRef.current;
      if (!jobId || audio.paused || audio.ended) return;
      const now = Date.now();
      if (now - lastSavedAt < SHELL_RESUME_INTERVAL_MS) return;
      const saved = saveShellResume(browserPrefStore(), {
        jobId,
        elementSeconds: audio.currentTime,
        elementOffset: bookOffsetRef.current,
        readyState: audio.readyState,
        nowSeconds: now / 1000,
      });
      if (saved) lastSavedAt = now;
    };

    // With the page mounted, `reportSession` owns the position (book clock).
    // Without it, this is the only place left that can move the scrubber.
    const publish = () => {
      // A released element has no book. Publishing its `pause` would put the
      // platform session back to `paused` after Close set it to `none`, which
      // is a notification that keeps a Play button and its slot.
      if (!jobIdRef.current || !srcRef.current) return;
      const element = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const elementDuration =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const report = reportRef.current;
      const offset = bookOffsetRef.current;
      const position = report?.active ? report.position : element + offset;
      const duration =
        report?.active && report.duration > 0 ? report.duration : elementDuration + offset;
      // The same rule the page uses, so the strip and the platform never
      // disagree with the transport about whether audio is running.
      const playing = elementIsPlaying(audio);
      if (position > 0.5) lastPositionRef.current = position;
      publishSession(position, duration, playing);
      saveResume();
      // The end of a part with the page gone: keep the book going on the one
      // element. `publish` runs on `ended`, where the report is null, so this
      // is the shell's own continuation.
      if (
        audio.ended &&
        !report &&
        partsRef.current.length > 0 &&
        !handingOffRef.current
      ) {
        const next = partsRef.current.find(
          (part) => part.startSeconds > bookOffsetRef.current + 0.5
        );
        if (next?.url) {
          handingOffRef.current = true;
          moveElementToBookSeconds(next.startSeconds + 0.01, true);
          window.setTimeout(() => {
            handingOffRef.current = false;
          }, 1000);
        }
      }
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

    // A tab closed from the mini player never fires a final `timeupdate`, and
    // the page that would have written on `pagehide` is already gone.
    const saveNow = () => {
      if (reportRef.current) return;
      const jobId = jobIdRef.current;
      if (!jobId || audio.readyState === 0) return;
      saveShellResume(browserPrefStore(), {
        jobId,
        elementSeconds: audio.currentTime,
        elementOffset: bookOffsetRef.current,
        readyState: audio.readyState,
        nowSeconds: Date.now() / 1000,
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveNow();
    };

    audio.addEventListener("play", publish);
    audio.addEventListener("playing", publish);
    audio.addEventListener("pause", publish);
    audio.addEventListener("timeupdate", publish);
    audio.addEventListener("durationchange", publish);
    audio.addEventListener("loadedmetadata", publish);
    audio.addEventListener("ended", publish);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", saveNow);
    return () => {
      audio.removeEventListener("play", publish);
      audio.removeEventListener("playing", publish);
      audio.removeEventListener("pause", publish);
      audio.removeEventListener("timeupdate", publish);
      audio.removeEventListener("durationchange", publish);
      audio.removeEventListener("loadedmetadata", publish);
      audio.removeEventListener("ended", publish);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", saveNow);
    };
    // `publishSession` already reads the current rate through its own deps;
    // re-attaching on every rate change would drop a `timeupdate`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    assignPlaybackRate(audio, speed);
    // A rate change is not a `timeupdate`: publish it now so the platform's
    // scrubber does not report the old rate until the next playhead move.
    // The page's report wins while it is mounted — it knows whether the book
    // is playable, while the element is only "not paused" for a moment.
    const element = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const elementDuration =
      Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const report = reportRef.current;
    if (report?.active) {
      // The element decides whether this is playing; the page only reports
      // where the book clock is.
      publishSession(report.position, report.duration, elementIsPlaying(audioRef.current));
      return;
    }
    publishSession(
      element + bookOffsetRef.current,
      elementDuration + bookOffsetRef.current,
      elementIsPlaying(audio)
    );
    // `publishSession` reads everything else through refs on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Pause first: the `pause` listener publishes `playbackState`, and it must
    // not overwrite the `none` below with a leftover `paused` (an Android
    // notification that reports paused keeps its Play button and its slot).
    if (audio) {
      // The one place a source is released on purpose: an explicit close or
      // a book that may not play. Never on pause or a hidden tab.
      audio.pause();
    }
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
      // Remember the part list so the shell can change parts after this page
      // unmounts. It is the page that knows each part's URL.
      partsRef.current = report.parts ?? [];
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

      // The element decides whether this is playing; the page only reports
      // where the book clock is.
      publishSession(report.position, report.duration, elementIsPlaying(audioRef.current));

      setIdentity((prev) => {
        const voice = metadata.artist ?? null;
        if (
          prev.jobId === report.jobId &&
          prev.title === metadata.title &&
          prev.voice === voice &&
          prev.canSeek === report.seekable
        ) {
          return prev;
        }
        return {
          jobId: report.jobId,
          title: metadata.title,
          voice,
          playing: prev.playing,
          canSeek: report.seekable,
          started: prev.started,
        };
      });
    },
    [audioRef, mediaSession, publishSession]
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
    () => ({
      audioRef,
      playing: identity.playing,
      setSource,
      releaseForJob,
      release,
      reportSession,
      detachSession,
    }),
    [audioRef, identity.playing, release, releaseForJob, reportSession, detachSession, setSource]
  );

  const routeJobId = playerIdFromPathname(pathname);
  // The mobile tab bar belongs to the dashboard chrome only. Everywhere else
  // the strip sits on the bottom edge, so it does not float above a gap.
  const aboveTabBar = pathname?.startsWith("/dashboard") ?? false;
  /**
   * The tab bar's real height, measured. A fixed `bottom-*` value drifted from
   * the bar it was clearing (the bar is 4.5rem, the strip sat at 4.25rem, so
   * the two overlapped by a few pixels on every phone).
   */
  const [tabBarHeight, setTabBarHeight] = useState(0);
  useEffect(() => {
    if (!aboveTabBar || typeof window === "undefined") {
      setTabBarHeight(0);
      return;
    }
    const read = () => {
      const bar = document.querySelector<HTMLElement>("[data-tab-bar]");
      setTabBarHeight(bar ? Math.round(bar.getBoundingClientRect().height) : 0);
    };
    read();
    let observer: ResizeObserver | null = null;
    const bar = document.querySelector<HTMLElement>("[data-tab-bar]");
    if (bar && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(read);
      observer.observe(bar);
    }
    window.addEventListener("resize", read);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [aboveTabBar, pathname]);
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
          tabBarHeight={aboveTabBar ? tabBarHeight : 0}
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
  tabBarHeight,
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
  /**
   * Pixels of mobile tab bar to clear. 0 outside the dashboard, or on a wide
   * screen where the bar is not rendered. Measured, not assumed, so the strip
   * cannot overlap the bar it is meant to sit above.
   */
  tabBarHeight: number;
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

  /**
   * The strip's real height, so the spacer below a page is exactly as tall as
   * what covers it. A hard-coded height drifted from the rendered strip and
   * left the last line of the page under it.
   */
  const sectionRef = useRef<HTMLElement | null>(null);
  const [stripHeight, setStripHeight] = useState(0);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setStripHeight(Math.round(el.getBoundingClientRect().height));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* The strip's own height, plus the tab bar on mobile, so the last line
          of a page is never hidden under either. */}
      <div
        aria-hidden="true"
        style={{ height: `${stripHeight + tabBarHeight}px` }}
      />
      <section
        ref={sectionRef}
        aria-label="Now playing"
        data-testid="mini-player"
        style={tabBarHeight ? { bottom: `${tabBarHeight}px` } : undefined}
        className={`fixed inset-x-0 z-40 border-t border-border/60 bg-background/95 backdrop-blur md:bottom-0 ${
          tabBarHeight ? "" : "bottom-0"
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
