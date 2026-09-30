"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import type { CloneAccent } from "@/lib/tts/clone-accent";
import { uploadCloneVoice, type UploadedCloneVoice } from "@/lib/upload-client";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";
import {
  canonicalYoutubeUrl,
  clampClipRange,
  defaultSpeechRange,
  formatClock,
  MIN_CLIP_SEC,
  parseYoutubeVideoId,
  validateClipRange,
  youtubeThumbnailUrl,
} from "@/lib/youtube/range";
import {
  currentTabCaptureSupport,
  displayMediaAudioConstraints,
  playbackAdvanced,
  recordingShouldStop,
  streamHasAudio,
  type TabCaptureSupport,
} from "@/lib/youtube/tab-capture";
import { audioBufferToWavBytes } from "@/lib/youtube/wav-bytes";

type SuggestedRange = NonNullable<ReturnType<typeof defaultSpeechRange>>;

export type YoutubeHit = {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnailUrl: string;
  url: string;
  suggestedRange: SuggestedRange | null;
};

type YtPlayer = {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
};

type YtNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YtPlayer }) => void;
        onError?: () => void;
      };
    }
  ) => YtPlayer;
};

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApi: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (youtubeApi) return youtubeApi;
  youtubeApi = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  });
  return youtubeApi;
}

export function YoutubeClipPicker({
  title,
  accent,
  disabled,
  onCloned,
  onBusy,
  onUploadInstead,
}: {
  title: string;
  accent: CloneAccent;
  disabled?: boolean;
  onCloned: (clone: UploadedCloneVoice) => void;
  onBusy?: (busy: boolean) => void;
  onUploadInstead: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YoutubeHit[] | null>(null);
  const [selected, setSelected] = useState<YoutubeHit | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [range, setRange] = useState<SuggestedRange | null>(null);
  const [consent, setConsent] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState<TabCaptureSupport | "unknown">("unknown");
  const [micRecording, setMicRecording] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const previewReadyRef = useRef(false);
  const recordingRef = useRef(false);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const videoId = selected?.videoId ?? null;

  useEffect(() => {
    setCapture(currentTabCaptureSupport());
  }, []);

  useEffect(() => {
    if (!videoId) return;
    const container = hostRef.current;
    if (!container) return;
    let cancelled = false;
    let poll = 0;
    previewReadyRef.current = false;
    container.replaceChildren();
    const host = document.createElement("div");
    host.className = "h-full w-full";
    container.appendChild(host);
    void loadYouTubeApi().then(() => {
      if (cancelled || !window.YT?.Player) return;
      const player = new window.YT.Player(host, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            if (cancelled) return;
            playerRef.current = event.target;
            const reported = event.target.getDuration();
            if (reported >= MIN_CLIP_SEC) {
              previewReadyRef.current = true;
              setDurationSec((current) =>
                current && current >= MIN_CLIP_SEC ? current : reported
              );
              setRange((current) => current ?? defaultSpeechRange(reported));
              setError((current) =>
                current === YOUTUBE_COPY.previewFailed ? null : current
              );
            }
            const start = rangeRef.current?.startSec ?? 0;
            event.target.seekTo(start, true);
          },
          onError: () => {
            if (!cancelled && !previewReadyRef.current) {
              setError(YOUTUBE_COPY.previewFailed);
            }
          },
        },
      });
      playerRef.current = player;
      poll = window.setInterval(() => {
        const current = playerRef.current;
        const end = rangeRef.current?.endSec;
        if (!current || end == null || recordingRef.current) return;
        try {
          if (current.getCurrentTime() >= end - 0.05) {
            current.pauseVideo();
            current.seekTo(rangeRef.current?.startSec ?? 0, true);
          }
        } catch {
          /* player not ready */
        }
      }, 250);
    });
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      try {
        playerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
      container.replaceChildren();
    };
  }, [videoId]);

  const seek = (seconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    try {
      player.seekTo(seconds, true);
      player.playVideo();
    } catch {
      /* player not ready */
    }
  };

  const choose = (hit: YoutubeHit) => {
    setSelected(hit);
    setDurationSec(hit.durationSec >= MIN_CLIP_SEC ? hit.durationSec : null);
    setRange(hit.suggestedRange);
    setConsent(false);
    setError(null);
  };

  const search = async () => {
    const text = query.trim();
    if (!text || searching || busy) return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const response = await fetch(
        `/api/tts/youtube/search?q=${encodeURIComponent(text)}`
      );
      const data = (await response.json().catch(() => ({}))) as {
        results?: YoutubeHit[];
        error?: string;
      };
      if (!response.ok) {
        const id = parseYoutubeVideoId(text);
        if (id) {
          choose(fallbackHit(id));
          setResults([fallbackHit(id)]);
          return;
        }
        setError(data.error || YOUTUBE_COPY.searchUnavailable);
        return;
      }
      const hits = data.results ?? [];
      setResults(hits);
      if (hits.length === 1) choose(hits[0]!);
      else if (hits.length === 0) setError(YOUTUBE_COPY.noResults);
    } catch {
      const id = parseYoutubeVideoId(text);
      if (id) {
        choose(fallbackHit(id));
        setResults([fallbackHit(id)]);
      } else {
        setError(YOUTUBE_COPY.searchUnavailable);
      }
    } finally {
      setSearching(false);
    }
  };

  const finishRecording = async (
    blob: Blob,
    youtube: { videoId: string; startSec: number; endSec: number } | null
  ) => {
    setPhase(YOUTUBE_COPY.workingClone);
    const file = await recordingToFile(blob);
    const clone = await uploadCloneVoice(file, {
      title: title.trim() || selected?.title || "My voice",
      accent,
      ...(youtube ? { youtube } : {}),
    });
    onCloned(clone);
    setSelected(null);
    setResults(null);
    setQuery("");
    setConsent(false);
  };

  const submitClip = async () => {
    if (!selected || !range || !consent || busy || disabled) return;
    if (capture !== "supported") return;
    const check = validateClipRange(
      range.startSec,
      range.endSec,
      durationSec ?? undefined
    );
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setBusy(true);
    setPhase(YOUTUBE_COPY.workingShare);
    setError(null);
    onBusy?.(true);
    recordingRef.current = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaAudioConstraints() as DisplayMediaStreamOptions
      );
      if (!streamHasAudio(stream)) {
        stopTracks(stream);
        setError(YOUTUBE_COPY.needTabAudio);
        return;
      }
      setPhase(YOUTUBE_COPY.workingRecord);
      const recorded = await recordUntilRange({
        stream,
        startSec: check.startSec,
        endSec: check.endSec,
        currentTime: () => playerRef.current?.getCurrentTime() ?? check.startSec,
        play: () => {
          playerRef.current?.seekTo(check.startSec, true);
          playerRef.current?.playVideo();
        },
        pause: () => playerRef.current?.pauseVideo(),
      });
      if (!playbackAdvanced(check.startSec, recorded.latestTime)) {
        setError(YOUTUBE_COPY.didntPlay);
        return;
      }
      await finishRecording(recorded.blob, {
        videoId: selected.videoId,
        startSec: check.startSec,
        endSec: check.endSec,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "AbortError") {
        setError(YOUTUBE_COPY.shareCancelled);
      } else {
        setError(err instanceof Error ? err.message : YOUTUBE_COPY.shareCancelled);
      }
    } finally {
      recordingRef.current = false;
      if (stream) stopTracks(stream);
      setBusy(false);
      setPhase("");
      onBusy?.(false);
    }
  };

  const toggleMic = async () => {
    if (micRecorderRef.current && micRecorderRef.current.state === "recording") {
      micRecorderRef.current.stop();
      return;
    }
    if (busy || disabled) return;
    if (selected && !consent) return;
    setError(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicRecording(true);
      const started = performance.now();
      const blob = await recordStream(stream, (recorder) => {
        micRecorderRef.current = recorder;
      }, () => (performance.now() - started) / 1000 >= 60);
      const elapsed = (performance.now() - started) / 1000;
      setMicRecording(false);
      micRecorderRef.current = null;
      if (elapsed < 10) {
        setError(YOUTUBE_COPY.micTooShort);
        return;
      }
      setBusy(true);
      onBusy?.(true);
      const youtube =
        selected && range
          ? {
              videoId: selected.videoId,
              startSec: range.startSec,
              endSec: range.endSec,
            }
          : null;
      await finishRecording(blob, youtube);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError"
          ? YOUTUBE_COPY.micNeedPermission
          : err instanceof Error
            ? err.message
            : YOUTUBE_COPY.micNeedPermission
      );
    } finally {
      setMicRecording(false);
      micRecorderRef.current = null;
      if (stream) stopTracks(stream);
      setBusy(false);
      onBusy?.(false);
      setPhase("");
    }
  };

  const duration = durationSec && durationSec >= MIN_CLIP_SEC ? durationSec : null;
  const rangeOk = range
    ? validateClipRange(range.startSec, range.endSec, duration ?? undefined).ok
    : false;

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="sr-only" htmlFor="youtube-query">
          YouTube link or search
        </label>
        <div className="flex items-end gap-3">
          <input
            id="youtube-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={YOUTUBE_COPY.searchPlaceholder}
            maxLength={200}
            disabled={disabled || busy}
            className="min-h-12 w-full border-0 border-b border-border/40 bg-transparent text-sm outline-none focus:border-border disabled:opacity-30"
          />
          <button
            type="submit"
            disabled={disabled || busy || searching || !query.trim()}
            className="inline-flex min-h-12 shrink-0 items-center px-1 text-sm text-foreground hover:opacity-70 disabled:opacity-30"
          >
            {searching ? YOUTUBE_COPY.searching : YOUTUBE_COPY.search}
          </button>
        </div>
      </form>

      {capture === "unsupported" && !selected ? (
        <div className="space-y-3">
          <p className="text-sm leading-snug text-muted-foreground">
            {YOUTUBE_COPY.unsupported}
          </p>
          <button
            type="button"
            onClick={() => void toggleMic()}
            disabled={disabled || busy}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 border border-border/60 text-sm hover:bg-foreground/5 disabled:opacity-30"
          >
            {micRecording ? YOUTUBE_COPY.stopMic : YOUTUBE_COPY.recordMic}
          </button>
        </div>
      ) : null}

      {results && results.length > 0 ? (
        <ul className="space-y-1" aria-label="YouTube results">
          {results.map((hit) => {
            const active = selected?.videoId === hit.videoId;
            return (
              <li key={hit.videoId}>
                <button
                  type="button"
                  onClick={() => choose(hit)}
                  disabled={disabled || busy}
                  className={`flex min-h-16 w-full items-center gap-3 rounded-sm px-1 py-2 text-left touch-manipulation disabled:opacity-30 ${
                    active ? "bg-foreground/5" : "hover:bg-foreground/5"
                  }`}
                >
                  <Image
                    src={youtubeThumbnailUrl(hit.videoId)}
                    alt=""
                    width={320}
                    height={180}
                    className="h-14 w-24 shrink-0 rounded-sm object-cover bg-foreground/5"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{hit.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[hit.channel, hit.durationSec >= MIN_CLIP_SEC ? formatClock(hit.durationSec) : ""]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {selected ? (
        <div className="space-y-4">
          <div className="relative aspect-video w-full overflow-hidden rounded-sm bg-foreground/5">
            <div ref={hostRef} className="absolute inset-0" />
          </div>
          {duration && range ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{formatClock(range.startSec)}</span>
                <span>{Math.round(range.endSec - range.startSec)}s</span>
                <span>{formatClock(range.endSec)}</span>
              </div>
              <Slider
                min={0}
                max={duration}
                step={0.5}
                value={[range.startSec, range.endSec]}
                disabled={disabled || busy}
                aria-label={YOUTUBE_COPY.rangeLabel}
                onValueChange={(value) => {
                  const start = value[0] ?? range.startSec;
                  const end = value[1] ?? range.endSec;
                  const anchor =
                    Math.abs(start - range.startSec) >= Math.abs(end - range.endSec)
                      ? "start"
                      : "end";
                  const next = clampClipRange(start, end, duration, anchor);
                  if (!next) return;
                  setRange(next);
                  seek(
                    anchor === "end"
                      ? Math.max(next.startSec, next.endSec - 1.2)
                      : next.startSec
                  );
                }}
              />
              <p className="text-xs text-muted-foreground">{YOUTUBE_COPY.rangeHint}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading the video…</p>
          )}
          {duration != null && duration < MIN_CLIP_SEC ? (
            <p className="text-sm text-muted-foreground">
              That video is shorter than 10 seconds. Pick another, or upload a file.
            </p>
          ) : null}
          <label className="flex min-h-12 items-start gap-3 text-sm leading-snug">
            <input
              type="checkbox"
              checked={consent}
              disabled={disabled || busy}
              onChange={(event) => setConsent(event.target.checked)}
              className="mt-0.5 size-6 shrink-0 accent-foreground"
            />
            <span>{YOUTUBE_COPY.consent}</span>
          </label>
          {capture === "supported" ? (
            <>
              <p className="text-sm leading-snug text-muted-foreground">
                {YOUTUBE_COPY.shareHint}
              </p>
              <button
                type="button"
                onClick={() => void submitClip()}
                disabled={disabled || busy || !consent || !rangeOk}
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 border border-border/60 text-sm hover:bg-foreground/5 disabled:opacity-30"
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {phase || YOUTUBE_COPY.workingRecord}
                  </>
                ) : (
                  YOUTUBE_COPY.useClip
                )}
              </button>
            </>
          ) : capture === "unsupported" ? (
            <div className="space-y-3">
              <p className="text-sm leading-snug text-muted-foreground">
                {YOUTUBE_COPY.unsupported}
              </p>
              <button
                type="button"
                onClick={() => void toggleMic()}
                disabled={disabled || busy || !consent}
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 border border-border/60 text-sm hover:bg-foreground/5 disabled:opacity-30"
              >
                {micRecording ? YOUTUBE_COPY.stopMic : YOUTUBE_COPY.recordMic}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={onUploadInstead}
            className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
          >
            {YOUTUBE_COPY.uploadInstead}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function fallbackHit(videoId: string): YoutubeHit {
  return {
    videoId,
    title: "YouTube video",
    channel: "",
    durationSec: 0,
    thumbnailUrl: youtubeThumbnailUrl(videoId),
    url: canonicalYoutubeUrl(videoId),
    suggestedRange: null,
  };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function recorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    return "audio/webm;codecs=opus";
  }
  return "audio/webm";
}

function recordStream(
  stream: MediaStream,
  onRecorder: (recorder: MediaRecorder) => void,
  shouldStop: () => boolean
): Promise<Blob> {
  const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), {
    mimeType: recorderMime(),
  });
  onRecorder(recorder);
  const chunks: Blob[] = [];
  return new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error("Recording failed."));
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    recorder.start(200);
    const timer = window.setInterval(() => {
      if (shouldStop() && recorder.state === "recording") recorder.stop();
    }, 200);
    recorder.addEventListener("stop", () => window.clearInterval(timer));
  });
}

async function recordUntilRange(opts: {
  stream: MediaStream;
  startSec: number;
  endSec: number;
  currentTime: () => number;
  play: () => void;
  pause: () => void;
}): Promise<{ blob: Blob; latestTime: number }> {
  const started = performance.now();
  let latest = opts.startSec;
  const blob = await new Promise<Blob>((resolve, reject) => {
    const recorder = new MediaRecorder(new MediaStream(opts.stream.getAudioTracks()), {
      mimeType: recorderMime(),
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error("Recording failed."));
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    recorder.start(200);
    opts.play();
    const timer = window.setInterval(() => {
      latest = opts.currentTime();
      const stop = recordingShouldStop({
        startSec: opts.startSec,
        endSec: opts.endSec,
        currentTime: latest,
        elapsedSec: (performance.now() - started) / 1000,
      });
      if (stop && recorder.state === "recording") {
        window.clearInterval(timer);
        opts.pause();
        recorder.stop();
      }
    }, 200);
  });
  return { blob, latestTime: latest };
}

async function recordingToFile(blob: Blob): Promise<File> {
  try {
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    await ctx.close();
    const wav = audioBufferToWavBytes(decoded);
    const copy = new Uint8Array(wav.byteLength);
    copy.set(wav);
    return new File([copy], "clip.wav", { type: "audio/wav" });
  } catch {
    const type = blob.type || "audio/webm";
    return new File([blob], type.includes("wav") ? "clip.wav" : "clip.webm", { type });
  }
}
