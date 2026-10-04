"use client";

import { useEffect, type RefObject } from "react";

export interface SessionActions {
  play: () => void;
  pause: () => void;
  seekBy: (delta: number) => void;
  seekTo: (seconds: number) => void;
  previous: () => void;
  next: () => void;
}

function setHandler(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null
) {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // This browser does not implement the action.
  }
}

/**
 * Lock screen, notification, and Bluetooth controls. Chapter skip is wired
 * only when the book has somewhere to skip; play, pause, and seek stay.
 */
export function useAudiobookSession(input: {
  active: boolean;
  title: string;
  artist?: string;
  album?: string;
  artwork?: string | null;
  duration: number;
  position: number;
  playbackRate: number;
  playing: boolean;
  seekable: boolean;
  chapterSkip: boolean;
  actions: RefObject<SessionActions>;
}) {
  const {
    active,
    title,
    artist,
    album,
    artwork,
    duration,
    position,
    playbackRate,
    playing,
    seekable,
    chapterSkip,
    actions,
  } = input;

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (typeof MediaMetadata !== "function") return;
    const session = navigator.mediaSession;
    const art = artwork
      ? [{ src: artwork, sizes: "512x512" }]
      : undefined;
    session.metadata = new MediaMetadata({
      title,
      ...(artist ? { artist } : {}),
      ...(album ? { album } : {}),
      ...(art ? { artwork: art } : {}),
    });
    const call = () => actions.current;
    setHandler(session, "play", () => call()?.play());
    setHandler(session, "pause", () => call()?.pause());
    if (seekable) {
      setHandler(session, "seekbackward", (details) => {
        call()?.seekBy(-(details.seekOffset || 10));
      });
      setHandler(session, "seekforward", (details) => {
        call()?.seekBy(details.seekOffset || 10);
      });
      setHandler(session, "seekto", (details) => {
        if (typeof details.seekTime === "number") call()?.seekTo(details.seekTime);
      });
    } else {
      setHandler(session, "seekbackward", null);
      setHandler(session, "seekforward", null);
      setHandler(session, "seekto", null);
    }
    if (chapterSkip) {
      setHandler(session, "previoustrack", () => call()?.previous());
      setHandler(session, "nexttrack", () => call()?.next());
    } else {
      setHandler(session, "previoustrack", null);
      setHandler(session, "nexttrack", null);
    }
    return () => {
      setHandler(session, "play", null);
      setHandler(session, "pause", null);
      setHandler(session, "seekbackward", null);
      setHandler(session, "seekforward", null);
      setHandler(session, "seekto", null);
      setHandler(session, "previoustrack", null);
      setHandler(session, "nexttrack", null);
      session.metadata = null;
    };
  }, [active, title, artist, album, artwork, seekable, chapterSkip, actions]);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.playbackState = playing ? "playing" : "paused";
    if (!(duration > 0) || !Number.isFinite(position)) return;
    const playback = playbackRate > 0 ? playbackRate : 1;
    const at = Math.min(duration, Math.max(0, position));
    try {
      session.setPositionState({ duration, playbackRate: playback, position: at });
    } catch {
      // Some browsers reject a position that lands on the exact duration.
    }
  }, [active, playing, duration, position, playbackRate]);
}
