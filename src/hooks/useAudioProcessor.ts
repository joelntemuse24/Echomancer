"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { usePlaybackSpeed } from "@/hooks/use-playback-speed";

/** Same level the old Web Audio gain node applied. */
const DEFAULT_ELEMENT_VOLUME = 0.75;

/**
 * Player audio helper: element volume plus the remembered playback speed so
 * the quiet cycle control can show the active rate.
 *
 * Speed comes from the shared preference store (`usePlaybackSpeed`), so a
 * reload, the next book, and the mini player all show the same rate. A value
 * that is not one of the 0.8×–1.5× presets is snapped to the nearest one.
 *
 * The element is not routed through Web Audio
 * (`createMediaElementSource`). Audio plays from a presigned R2 URL that
 * `/api/storage` redirects to, and a cross-origin media element taints a Web
 * Audio graph, which then outputs silence. The graph only applied a fixed
 * 0.75 gain, so `audio.volume` carries that instead (iOS ignores it, as it
 * ignores page volume generally). Because there is no graph, nothing can be
 * left suspended in the background and mute a resumed listen.
 */
export function useAudioProcessor() {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [error] = useState<string | null>(null);
  const { speed, setSpeed } = usePlaybackSpeed();

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
