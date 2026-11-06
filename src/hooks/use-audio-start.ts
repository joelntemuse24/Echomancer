"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  START_FAILED_NOTICE,
  START_WATCHDOG_MS,
  mediaSnapshot,
  planStart,
  startFailureNotice,
  startIsStuck,
  type MediaSnapshot,
} from "@/lib/player/audio-start";

/** The seek the page wants applied once the new source's metadata lands. */
export interface PendingSeekRef {
  current: { seconds: number | null; fraction: number } | null;
}

interface AudioStartOptions {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Set when a reload must resume by itself (`canplay` starts it). */
  playAfterLoadRef: RefObject<boolean>;
  pendingSeekRef: PendingSeekRef;
  /** Quiet line under the title; null clears it. */
  onNotice: (message: string | null) => void;
  /** Browser-policy hook (no AudioContext any more, but callers may await). */
  resume?: () => Promise<void>;
}

/**
 * Starting playback on an `<audio>` element that may not be able to start.
 *
 * `audio.play()` looks like the answer and is not. The production transport
 * showed Play over a 0:00 clock, with no toast, for as long as the listener
 * waited, because the element was in one of two states and neither one
 * reports through the promise:
 *
 *  - **Source selection failed** (`error` set, `networkState` NO_SOURCE). The
 *    promise rejects at once; without a fresh `load()` every later tap
 *    rejects the same way.
 *  - **The load hangs.** The promise stays pending, no `play` / `canplay` /
 *    `error` event arrives, and elapsed time never moves.
 *
 * Tapping a Parts row repaired both, because it replaces `src` (or resets the
 * playhead when the URL is unchanged) and makes the browser select the
 * resource again. This hook gives the transport that same repair, once per
 * start request, and then says so instead of tapping at a dead element.
 *
 * `lib/player/audio-start.ts` holds the decisions; this file only owns the
 * element, the watchdog timer, and how many repairs this start has spent.
 */
export function useAudioStart({
  audioRef,
  playAfterLoadRef,
  pendingSeekRef,
  onNotice,
  resume,
}: AudioStartOptions) {
  /** Recovery `load()`s spent on the current start request. */
  const recoveryRef = useRef(0);
  /** When the current start request began. */
  const startedAtRef = useRef(0);
  /** The element as it looked when the request began (playhead, readyState). */
  const baselineRef = useRef<MediaSnapshot | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current != null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  /** The element answered: a new start request owns its own budget. */
  const settle = useCallback(() => {
    clearWatchdog();
    recoveryRef.current = 0;
  }, [clearWatchdog]);

  /** Re-select the source; `canplay` then starts it. */
  const reloadForPlayback = useCallback(
    (audio: HTMLAudioElement) => {
      recoveryRef.current += 1;
      // A reload resets the playhead. Keep a real position; a stuck start has none.
      if (audio.currentTime > 0.05) {
        pendingSeekRef.current = { seconds: audio.currentTime, fraction: 0 };
      }
      playAfterLoadRef.current = true;
      audio.load();
    },
    [pendingSeekRef, playAfterLoadRef]
  );

  const playElement = useCallback(
    (audio: HTMLAudioElement) => {
      let pending: Promise<void>;
      try {
        pending = audio.play();
      } catch (error) {
        clearWatchdog();
        const notice = startFailureNotice(error);
        if (notice) onNotice(notice);
        return;
      }
      pending.then(
        () => {
          settle();
          onNotice(null);
        },
        (error: unknown) => {
          clearWatchdog();
          // Our own pause or a newer load: not a failure, not worth a line.
          const notice = startFailureNotice(error);
          if (notice) {
            recoveryRef.current = 0;
            onNotice(notice);
          }
        }
      );
    },
    [clearWatchdog, onNotice, settle]
  );

  const scheduleWatchdog = useCallback(
    (audio: HTMLAudioElement) => {
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null;
        if (audioRef.current !== audio) return;
        const baseline = baselineRef.current;
        if (!baseline) return;
        const waited = Date.now() - startedAtRef.current;
        const now = mediaSnapshot(audio);
        if (!startIsStuck(baseline, now, waited)) return;
        if (planStart(now, recoveryRef.current, true) === "unavailable") {
          recoveryRef.current = 0;
          onNotice(START_FAILED_NOTICE);
          return;
        }
        reloadForPlayback(audio);
      }, START_WATCHDOG_MS);
    },
    [audioRef, clearWatchdog, onNotice, reloadForPlayback]
  );

  /** Play, or repair the element once and then play. */
  const start = useCallback(
    (audio: HTMLAudioElement) => {
      // Never await before `play()`. Transient user activation is what lets a
      // tap start audio, and on stricter engines it does not survive an await
      // that crosses a task. The Parts row played synchronously inside its
      // handler for the same reason; the transport has to match it.
      void resume?.();
      const snapshot = mediaSnapshot(audio);
      baselineRef.current = snapshot;
      startedAtRef.current = Date.now();
      scheduleWatchdog(audio);

      const plan = planStart(snapshot, recoveryRef.current);
      if (plan === "unavailable") {
        clearWatchdog();
        recoveryRef.current = 0;
        onNotice(START_FAILED_NOTICE);
        return;
      }
      if (plan === "reload-and-play") {
        reloadForPlayback(audio);
        return;
      }
      playElement(audio);
    },
    [clearWatchdog, onNotice, playElement, reloadForPlayback, resume, scheduleWatchdog]
  );

  const stop = useCallback(() => {
    clearWatchdog();
    audioRef.current?.pause();
  }, [audioRef, clearWatchdog]);

  /** A new source is a new start request. */
  const reset = useCallback(() => {
    clearWatchdog();
    recoveryRef.current = 0;
    baselineRef.current = null;
  }, [clearWatchdog]);

  useEffect(() => clearWatchdog, [clearWatchdog]);

  return { start, stop, settle, reset };
}
