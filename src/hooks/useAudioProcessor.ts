"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { DEFAULT_PLAYBACK_SPEED } from "@/lib/player/playback-speed";

/** Same level the old Web Audio gain node applied. */
const DEFAULT_ELEMENT_VOLUME = 0.75;

/**
 * Player audio helper: element volume plus the remembered playback speed so
 * the quiet cycle control can show the active rate. A fresh player starts at
 * 1.15×; a later choice replaces that until reload. Speed itself is applied
 * via `audio.playbackRate`.
 *
 * The element is no longer routed through Web Audio
 * (`createMediaElementSource`). Audio now plays from a presigned R2 URL that
 * `/api/storage` redirects to, and a cross-origin media element taints a Web
 * Audio graph, which then outputs silence. The graph only applied a fixed
 * 0.75 gain, so `audio.volume` carries that instead (iOS ignores it, as it
 * ignores page volume generally). The hook's API is unchanged.
 */
export function useAudioProcessor() {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [error] = useState<string | null>(null);
  const [speed, setSpeedState] = useState(DEFAULT_PLAYBACK_SPEED);

  const initialize = useCallback((audioElement: HTMLAudioElement) => {
    if (audioElementRef.current === audioElement) return;
    audioElementRef.current = audioElement;
    try {
      audioElement.volume = DEFAULT_ELEMENT_VOLUME;
    } catch {
      /* read-only on some platforms */
    }
    setIsReady(true);
  }, []);

  /** Kept for callers; there is no AudioContext to wake any more. */
  const resume = useCallback(async () => {}, []);

  const setSpeed = useCallback((next: number) => setSpeedState(next), []);

  const setVolume = useCallback((volume: number) => {
    const el = audioElementRef.current;
    if (!el) return;
    try {
      el.volume = Math.min(1, Math.max(0, volume / 100));
    } catch {
      /* read-only on some platforms */
    }
  }, []);

  const cleanup = useCallback(() => {
    audioElementRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  return {
    initialize,
    resume,
    setSpeed,
    setVolume,
    cleanup,
    isReady,
    error,
    speed,
  };
}
