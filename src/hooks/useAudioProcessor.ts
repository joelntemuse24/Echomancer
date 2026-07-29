"use client";

import { useRef, useCallback, useEffect, useState } from "react";

/**
 * Web Audio wrapper for the player.
 *
 * Deliberately minimal: a single gain node for volume, plus the remembered
 * playback speed so the preset pills can show which one is active. Speed itself
 * is applied via `audio.playbackRate` — routing it through Web Audio would only
 * add a way for the two to disagree.
 *
 * An earlier version wired up a three-band EQ, a compressor and a stereo panner
 * with pitch/depth/dynamics setters. Nothing in the UI ever called them, so the
 * nodes sat at fixed values in every listener's audio path; they are gone.
 */
export function useAudioProcessor() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeedState] = useState(1);

  const initialize = useCallback((audioElement: HTMLAudioElement) => {
    try {
      // Already wired to this element: just make sure the context is running.
      if (
        audioElementRef.current === audioElement &&
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        if (audioContextRef.current.state === "suspended") {
          audioContextRef.current.resume().catch(() => {});
        }
        return;
      }

      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.disconnect();
        } catch {
          /* already disconnected */
        }
      }

      let audioContext = audioContextRef.current;
      if (!audioContext || audioContext.state === "closed") {
        audioContext = new (window.AudioContext ||
          (
            window as unknown as { webkitAudioContext: typeof AudioContext }
          ).webkitAudioContext)();
        audioContextRef.current = audioContext;
      }

      audioElementRef.current = audioElement;

      const source = audioContext.createMediaElementSource(audioElement);
      sourceNodeRef.current = source;

      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0.75;
      gainNodeRef.current = gainNode;

      source.connect(gainNode).connect(audioContext.destination);

      setIsReady(true);
      setError(null);
    } catch (err) {
      setIsReady(false);
      setError("Failed to initialize audio processor");
      console.error("Audio processor initialization failed:", err);
    }
  }, []);

  /** Browsers start the context suspended until a user gesture. */
  const resume = useCallback(async () => {
    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume();
    }
  }, []);

  const setSpeed = useCallback((next: number) => setSpeedState(next), []);

  const setVolume = useCallback((volume: number) => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.setTargetAtTime(
        Math.min(1, Math.max(0, volume / 100)),
        audioContextRef.current.currentTime,
        0.1
      );
    }
  }, []);

  const cleanup = useCallback(() => {
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    sourceNodeRef.current = null;
    gainNodeRef.current = null;
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
