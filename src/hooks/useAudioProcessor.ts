"use client";

import { useRef, useCallback, useEffect, useState } from "react";

interface AudioProcessorState {
  isReady: boolean;
  error: string | null;
}

interface AudioControls {
  speed: number;
  pitch: number;
  depth: number; // Low frequency boost/cut
  dynamics: number; // Compression threshold
}

export function useAudioProcessor() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const eqLowRef = useRef<BiquadFilterNode | null>(null);
  const eqMidRef = useRef<BiquadFilterNode | null>(null);
  const eqHighRef = useRef<BiquadFilterNode | null>(null);
  const stereoPannerRef = useRef<StereoPannerNode | null>(null);
  
  const [state, setState] = useState<AudioProcessorState>({ isReady: false, error: null });
  const [controls, setControls] = useState<AudioControls>({
    speed: 1,
    pitch: 0,
    depth: 0,
    dynamics: 50,
  });

  // Initialize audio context and connect nodes
  const initialize = useCallback((audioElement: HTMLAudioElement) => {
    try {
      if (audioContextRef.current?.state === "running") {
        return; // Already initialized
      }

      // Create audio context
      const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioContextRef.current = audioContext;

      // Create source from audio element
      const source = audioContext.createMediaElementSource(audioElement);
      sourceNodeRef.current = source;

      // Create EQ nodes
      const eqLow = audioContext.createBiquadFilter();
      eqLow.type = "lowshelf";
      eqLow.frequency.value = 200;
      eqLow.gain.value = 0;
      eqLowRef.current = eqLow;

      const eqMid = audioContext.createBiquadFilter();
      eqMid.type = "peaking";
      eqMid.frequency.value = 1000;
      eqMid.Q.value = 1;
      eqMid.gain.value = 0;
      eqMidRef.current = eqMid;

      const eqHigh = audioContext.createBiquadFilter();
      eqHigh.type = "highshelf";
      eqHigh.frequency.value = 4000;
      eqHigh.gain.value = 0;
      eqHighRef.current = eqHigh;

      // Create dynamics compressor
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 30;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      compressorRef.current = compressor;

      // Create gain node for volume
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0.75;
      gainNodeRef.current = gainNode;

      // Create stereo panner
      const panner = audioContext.createStereoPanner();
      panner.pan.value = 0;
      stereoPannerRef.current = panner;

      // Connect the chain:
      // source -> eqLow -> eqMid -> eqHigh -> compressor -> gain -> panner -> destination
      source
        .connect(eqLow)
        .connect(eqMid)
        .connect(eqHigh)
        .connect(compressor)
        .connect(gainNode)
        .connect(panner)
        .connect(audioContext.destination);

      setState({ isReady: true, error: null });
    } catch (err) {
      setState({ isReady: false, error: "Failed to initialize audio processor" });
      console.error("Audio processor initialization failed:", err);
    }
  }, []);

  // Resume audio context (needed after user interaction)
  const resume = useCallback(async () => {
    if (audioContextRef.current?.state === "suspended") {
      await audioContextRef.current.resume();
    }
  }, []);

  // Update speed (affects both pitch and speed naturally)
  const setSpeed = useCallback((speed: number) => {
    setControls(prev => ({ ...prev, speed }));
  }, []);

  // Update pitch shift (simulated via mid EQ for subtle effect)
  const setPitch = useCallback((pitch: number) => {
    // pitch is in semitones, -12 to +12
    setControls(prev => ({ ...prev, pitch }));
    
    // Adjust mid frequencies to simulate tonal shift
    if (eqMidRef.current && audioContextRef.current) {
      // Subtle mid-range adjustment to simulate voice character change
      const gain = pitch * 0.5;
      eqMidRef.current.gain.setTargetAtTime(gain, audioContextRef.current.currentTime, 0.1);
    }
  }, []);

  // Update depth (low frequency emphasis)
  const setDepth = useCallback((depth: number) => {
    // depth is -100 to 100, representing dB change
    setControls(prev => ({ ...prev, depth }));
    
    if (eqLowRef.current && audioContextRef.current) {
      const gain = (depth / 100) * 15; // Max ±15dB
      eqLowRef.current.gain.setTargetAtTime(gain, audioContextRef.current.currentTime, 0.1);
    }
  }, []);

  // Update dynamics (compression amount)
  const setDynamics = useCallback((dynamics: number) => {
    // dynamics is 0 to 100
    setControls(prev => ({ ...prev, dynamics }));
    
    if (compressorRef.current && audioContextRef.current) {
      // Map 0-100 to threshold -60 to -12
      const threshold = -60 + (dynamics / 100) * 48;
      compressorRef.current.threshold.setTargetAtTime(threshold, audioContextRef.current.currentTime, 0.1);
      
      // Also adjust ratio slightly
      const ratio = 1 + (dynamics / 100) * 19; // 1:1 to 20:1
      compressorRef.current.ratio.setTargetAtTime(ratio, audioContextRef.current.currentTime, 0.1);
    }
  }, []);

  // Update volume
  const setVolume = useCallback((volume: number) => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.setTargetAtTime(volume / 100, audioContextRef.current.currentTime, 0.1);
    }
  }, []);

  // Cleanup
  const cleanup = useCallback(() => {
    audioContextRef.current?.close();
    audioContextRef.current = null;
    sourceNodeRef.current = null;
    gainNodeRef.current = null;
    compressorRef.current = null;
    eqLowRef.current = null;
    eqMidRef.current = null;
    eqHighRef.current = null;
    stereoPannerRef.current = null;
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    initialize,
    resume,
    setSpeed,
    setPitch,
    setDepth,
    setDynamics,
    setVolume,
    cleanup,
    isReady: state.isReady,
    error: state.error,
    controls,
  };
}
