"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import type { CloneAccent } from "@/lib/tts/clone-accent";
import {
  completeCloneUpload,
  type CloneQualityRisk,
  type UploadedCloneVoice,
} from "@/lib/upload-client";
import { CloneQualityRiskNotice } from "@/components/clone-quality-risk";
import { REFERENCE_QUALITY_COPY } from "@/lib/tts/reference-quality/config";
import { proxyClipErrorCopy, YOUTUBE_COPY } from "@/lib/youtube/messages";
import {
  clipPhaseFromStatus,
  clipWaitProgress,
  type ClipWaitPhase,
} from "@/lib/youtube/clip-progress";
import {
  canonicalYoutubeUrl,
  clampClipRange,
  defaultSpeechRange,
  formatClock,
  MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  parseYoutubeVideoId,
  validateClipRange,
  youtubeThumbnailUrl,
} from "@/lib/youtube/range";
import { YOUTUBE_EMBED_QUALITY, youtubeEmbedPlayerVars } from "@/lib/youtube/embed";

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
  setPlaybackQuality?: (quality: string) => void;
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

function waitLabel(phase: ClipWaitPhase): string {
  if (phase === "preparing") return YOUTUBE_COPY.preparing;
  if (phase === "starting") return YOUTUBE_COPY.starting;
  return YOUTUBE_COPY.fetching;
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
  const [mode, setMode] = useState<"idle" | "clip" | "clone">("idle");
  const [waitPhase, setWaitPhase] = useState<ClipWaitPhase>("starting");
  const [waitRatio, setWaitRatio] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  /** Reference gate warning; the sample is uploaded and waiting. */
  const [risk, setRisk] = useState<{
    uploadId: string;
    risk: CloneQualityRisk;
    youtube: { videoId: string; startSec: number; endSec: number } | null;
    displayName: string;
  } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const previewReadyRef = useRef(false);
  const waitPhaseRef = useRef(waitPhase);
  waitPhaseRef.current = waitPhase;
  const videoId = selected?.videoId ?? null;

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/clips")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (!cancelled && data?.enabled) setProxyEnabled(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!busy || mode !== "clip") {
      setWaitRatio(0);
      return;
    }
    const started = performance.now();
    const tick = () => {
      setWaitRatio(clipWaitProgress(performance.now() - started, waitPhaseRef.current));
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => window.clearInterval(id);
  }, [busy, mode]);

  useEffect(() => {
    const frame = frameRef.current;
    const scale = scaleRef.current;
    if (!frame || !scale || !videoId) return;
    const fit = () => {
      const factor = (frame.clientWidth || 1) / 1280;
      scale.style.width = "1280px";
      scale.style.height = "720px";
      scale.style.transform = `scale(${factor})`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [videoId]);

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
        width: "1280",
        height: "720",
        playerVars: youtubeEmbedPlayerVars(window.location.origin),
        events: {
          onReady: (event) => {
            if (cancelled) return;
            playerRef.current = event.target;
            event.target.setPlaybackQuality?.(YOUTUBE_EMBED_QUALITY);
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
        if (!current || end == null) return;
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
    setRisk(null);
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

  const submitClip = async () => {
    if (!selected || !range || !consent || busy || disabled || !proxyEnabled) return;
    const lengthSeconds = Math.min(
      MAX_CLIP_SEC,
      Math.max(MIN_CLIP_SEC, Math.round(range.endSec - range.startSec))
    );
    setRisk(null);
    setBusy(true);
    setMode("clip");
    setWaitPhase("starting");
    setError(null);
    onBusy?.(true);
    try {
      const response = await fetch("/api/clips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId: selected.videoId,
          startSeconds: range.startSec,
          lengthSeconds,
          consent: true,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        id?: string;
        code?: string;
        error?: string;
      };
      if (response.status === 429 || data.code === "budget") {
        setError(proxyClipErrorCopy("budget"));
        return;
      }
      if (!response.ok || !data.id) {
        setError(proxyClipErrorCopy(data.code));
        return;
      }
      const id = data.id;
      // The actor is the long part. Poll often enough that the phase line moves.
      for (let i = 0; i < 120; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        const statusRes = await fetch(`/api/clips/${id}`);
        const status = (await statusRes.json().catch(() => ({}))) as {
          status?: string;
          phase?: string | null;
          error?: string | null;
          catalogVoiceId?: string | null;
        };
        setWaitPhase(clipPhaseFromStatus(status.status, status.phase));
        if (status.status === "ready" && status.catalogVoiceId) {
          onCloned({
            catalogVoiceId: status.catalogVoiceId,
            displayName: selected.title || "YouTube clip",
          });
          setSelected(null);
          setResults(null);
          setQuery("");
          setConsent(false);
          return;
        }
        if (status.status === "failed" && status.error === "risky_audio") {
          setRisk({
            uploadId: id,
            risk: {
              headline: REFERENCE_QUALITY_COPY.failHeadline,
              body: REFERENCE_QUALITY_COPY.failBody,
              issues: [],
            },
            youtube: {
              videoId: selected.videoId,
              startSec: range.startSec,
              endSec: range.startSec + lengthSeconds,
            },
            displayName: selected.title || "YouTube clip",
          });
          return;
        }
        if (status.status === "failed") {
          setError(proxyClipErrorCopy(status.error));
          return;
        }
      }
      setError(proxyClipErrorCopy("timeout"));
    } catch {
      setError(YOUTUBE_COPY.proxyFailed);
    } finally {
      setBusy(false);
      setMode("idle");
      onBusy?.(false);
    }
  };

  const continueRisky = async () => {
    if (!risk || busy) return;
    setBusy(true);
    setMode("clone");
    setError(null);
    onBusy?.(true);
    try {
      const clone = await completeCloneUpload(
        risk.uploadId,
        {
          title: title.trim() || risk.displayName,
          accent,
          ...(risk.youtube ? { youtube: risk.youtube } : {}),
        },
        { acceptQualityRisk: true }
      );
      setRisk(null);
      onCloned(clone);
      setSelected(null);
      setResults(null);
      setQuery("");
      setConsent(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : YOUTUBE_COPY.proxyFailed);
    } finally {
      setBusy(false);
      setMode("idle");
      onBusy?.(false);
    }
  };

  const duration = durationSec && durationSec >= MIN_CLIP_SEC ? durationSec : null;
  const rangeOk = range
    ? validateClipRange(range.startSec, range.endSec, duration ?? undefined).ok
    : false;
  const clipLabel = waitLabel(waitPhase);

  return (
    <div className="w-full space-y-3">
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

      {results && results.length > 0 ? (
        <ul className="space-y-1" aria-label={YOUTUBE_COPY.results}>
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
        <div className="space-y-3">
          <div
            ref={frameRef}
            className="relative aspect-video w-full overflow-hidden rounded-sm bg-foreground/5"
          >
            <div ref={scaleRef} className="absolute left-0 top-0 origin-top-left">
              <div ref={hostRef} className="h-full w-full" />
            </div>
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
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{YOUTUBE_COPY.loading}</p>
          )}
          {duration != null && duration < MIN_CLIP_SEC ? (
            <p className="text-sm text-muted-foreground">
              {YOUTUBE_COPY.tooShortVideo}
            </p>
          ) : null}
          {proxyEnabled ? (
            <>
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
              {busy && mode === "clip" ? (
                <div className="h-1 w-full bg-foreground/15" aria-hidden="true">
                  <div
                    className="h-1 bg-foreground"
                    style={{ width: `${Math.round(waitRatio * 100)}%` }}
                  />
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => void submitClip()}
                disabled={disabled || busy || !consent || !rangeOk}
                aria-live="polite"
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 border border-border/60 text-sm hover:bg-foreground/5 disabled:opacity-30"
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {mode === "clone" ? YOUTUBE_COPY.workingClone : clipLabel}
                  </>
                ) : (
                  YOUTUBE_COPY.useClip
                )}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {risk ? (
        <CloneQualityRiskNotice
          risk={risk.risk}
          busy={busy}
          onChooseAnother={() => {
            setRisk(null);
          }}
          onContinue={() => void continueRisky()}
        />
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
