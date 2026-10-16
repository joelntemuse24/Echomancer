"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { ClipRangeSlider } from "@/components/clip-range-slider";
import { cloneNameOrFallback } from "@/lib/clone-name";
import type { CloneAccent } from "@/lib/tts/clone-accent";
import {
  type CloneQualityRisk,
  type UploadedCloneVoice,
} from "@/lib/upload-client";
import { CloneQualityRiskNotice } from "@/components/clone-quality-risk";
import { CLIP_CLIENT_WAIT_MS } from "@/lib/youtube/clip-policy";
import { REFERENCE_QUALITY_COPY } from "@/lib/tts/reference-quality/config";
import { proxyClipErrorCopy, YOUTUBE_COPY } from "@/lib/youtube/messages";
import {
  clipPhaseFromStatus,
  clipWaitProgress,
  type ClipWaitPhase,
} from "@/lib/youtube/clip-progress";
import { clipRequestWindow, normalizeClipSpan } from "@/lib/youtube/clip-slider";
import {
  canonicalYoutubeUrl,
  defaultSpeechRange,
  formatClock,
  MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  parseYoutubeVideoId,
  parseYoutubeStartSec,
  parseClipTime,
  validateClipRange,
  youtubeThumbnailUrl,
} from "@/lib/youtube/range";
import { clipJson, clipPollDelay, readPendingClip, storePendingClip, waitForClipPoll, type ClipStatus, type PendingClip } from "@/lib/youtube/clip-client";
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
  youtubeApi = new Promise<void>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    const cleanup = () => {
      window.clearTimeout(timer);
      script.onerror = null;
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
    };
    const fail = () => {
      cleanup();
      script.remove();
      reject(new Error(YOUTUBE_COPY.previewFailed));
    };
    const ready = () => {
      cleanup();
      try { previous?.(); } finally { resolve(); }
    };
    const timer = window.setTimeout(fail, 12_000);
    window.onYouTubeIframeAPIReady = ready;
    script.onerror = fail;
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  }).catch((error) => {
    youtubeApi = null;
    throw error;
  });
  return youtubeApi;
}

function waitLabel(phase: ClipWaitPhase): string {
  if (phase === "preparing") return YOUTUBE_COPY.preparing;
  if (phase === "starting") return YOUTUBE_COPY.starting;
  return YOUTUBE_COPY.fetching;
}

export function YoutubeClipPicker({
  title = "",
  disabled,
  onCloned,
  onBusy,
  onUploadInstead,
}: {
  /** Optional override. Empty uses the video title. */
  title?: string;
  accent?: CloneAccent;
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
  const [accessChecked, setAccessChecked] = useState(false);
  const [ownerContext, setOwnerContext] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingClip | null>(null);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState(false);
  const [playerAttempt, setPlayerAttempt] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);
  const linkedStartRef = useRef<number | null>(null);
  const clipMetadataRef = useRef<{ displayName: string; youtube: { videoId: string; startSec: number; endSec: number } } | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const callbacksRef = useRef({ onCloned, onBusy });
  callbacksRef.current = { onCloned, onBusy };
  /** Reference gate warning; the sample is uploaded and waiting. */
  const [risk, setRisk] = useState<{
    uploadId: string;
    risk: CloneQualityRisk;
    youtube: { videoId: string; startSec: number; endSec: number } | null;
    displayName: string;
  } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const previewReadyRef = useRef(false);
  const selectionPlaybackRef = useRef(false);
  const waitPhaseRef = useRef(waitPhase);
  waitPhaseRef.current = waitPhase;
  const videoId = selected?.videoId ?? null;
  const privateOutputRef = useRef({ ownerContext, sampleUrl, risk });
  privateOutputRef.current = { ownerContext, sampleUrl, risk };

  useEffect(() => {
    const controller = new AbortController();
    let checkVersion = 0;
    const check = async () => {
      const version = ++checkVersion;
      const previous = privateOutputRef.current;
      // Hide private output immediately while the browser's current owner is checked.
      setSampleUrl(null);
      setRisk(null);
      setProxyEnabled(false);
      try {
        const { response, data } = await clipJson<{ enabled?: boolean; ownerContext?: string }>("/api/clips", {}, controller.signal);
        if (controller.signal.aborted || version !== checkVersion) return;
        const owner = response.ok && data.enabled && typeof data.ownerContext === "string" ? data.ownerContext : null;
        setProxyEnabled(response.ok && data.enabled === true && owner != null);
        setAccessChecked(true);
        setOwnerContext(owner);
        if (owner) {
          setPending((current) => current?.ownerContext === owner ? current : readPendingClip(owner));
          if (previous.ownerContext === owner) {
            setSampleUrl(previous.sampleUrl);
            setRisk(previous.risk);
          }
        }
        else {
          storePendingClip(null);
          if (!data.enabled) setPending(null);
        }
      } catch {
        if (controller.signal.aborted) return;
        setAccessChecked(true);
        setOwnerContext(null);
        setPending(null);
      }
    };
    void check();
    const refresh = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      operationRef.current?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      callbacksRef.current.onBusy?.(false);
    };
  }, []);

  useEffect(() => {
    if (!busy || mode !== "clip") {
      setWaitRatio(0);
      return;
    }
    const started = pending?.startedAt ?? Date.now();
    const tick = () => {
      setWaitRatio(clipWaitProgress(Date.now() - started, waitPhaseRef.current));
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => window.clearInterval(id);
  }, [busy, mode, pending?.startedAt]);

  useEffect(() => {
    if (!videoId) return;
    const container = hostRef.current;
    if (!container) return;
    let cancelled = false;
    let poll = 0;
    previewReadyRef.current = false;
    selectionPlaybackRef.current = false;
    setPlayerReady(false);
    setPlayerError(false);
    const readyTimeout = window.setTimeout(() => { if (!cancelled && !previewReadyRef.current) setPlayerError(true); }, 20_000);
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
        playerVars: youtubeEmbedPlayerVars(window.location.origin),
        events: {
          onReady: (event) => {
            if (cancelled) return;
            window.clearTimeout(readyTimeout);
            previewReadyRef.current = true;
            setPlayerReady(true);
            setPlayerError(false);
            playerRef.current = event.target;
            event.target.setPlaybackQuality?.(YOUTUBE_EMBED_QUALITY);
            const reported = event.target.getDuration();
            if (reported > 0) {
              previewReadyRef.current = true;
              setDurationSec((current) =>
                current && current >= MIN_CLIP_SEC ? current : reported
              );
              setRange((current) => {
                if (current) return current;
                const next = rangeAtTimestamp(reported, linkedStartRef.current);
                return next ? normalizeClipSpan(next.startSec, next.endSec, reported) : null;
              });
              setError((current) =>
                current === YOUTUBE_COPY.previewFailed ? null : current
              );
            }
            const start = rangeRef.current?.startSec ?? rangeAtTimestamp(reported, linkedStartRef.current)?.startSec ?? 0;
            event.target.seekTo(start, true);
          },
          onError: () => {
            if (!cancelled) {
              setPlayerError(true);
              setPlayerReady(false);
            }
          },
        },
      });
      playerRef.current = player;
      poll = window.setInterval(() => {
        const current = playerRef.current;
        const end = rangeRef.current?.endSec;
        if (!current || end == null || !selectionPlaybackRef.current) return;
        try {
          if (current.getCurrentTime() >= end - 0.05) {
            selectionPlaybackRef.current = false;
            current.pauseVideo();
            current.seekTo(rangeRef.current?.startSec ?? 0, true);
          }
        } catch {
          /* player not ready */
        }
      }, 250);
    }).catch(() => { if (!cancelled) setPlayerError(true); });
    return () => {
      cancelled = true;
      window.clearTimeout(readyTimeout);
      window.clearInterval(poll);
      try {
        playerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
      container.replaceChildren();
    };
  }, [videoId, playerAttempt]);

  const seek = (seconds: number, play = false) => {
    const player = playerRef.current;
    if (!player) return;
    try {
      selectionPlaybackRef.current = play;
      player.seekTo(seconds, true);
      if (play) player.playVideo();
    } catch {
      /* player not ready */
    }
  };

  const choose = (hit: YoutubeHit, timestamp: number | null = null) => {
    linkedStartRef.current = timestamp;
    setSampleUrl(null);
    setTimeError(null);
    setRisk(null);
    if (selected?.videoId === hit.videoId) setPlayerAttempt((value) => value + 1);
    setSelected(hit);
    setDurationSec(hit.durationSec > 0 ? hit.durationSec : null);
    setRange(
      timestamp != null
        ? rangeAtTimestamp(hit.durationSec, timestamp)
        : hit.suggestedRange && hit.durationSec >= MIN_CLIP_SEC
          ? normalizeClipSpan(hit.suggestedRange.startSec, hit.suggestedRange.endSec, hit.durationSec)
          : null
    );
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
      const { response, data } = await clipJson<{ results?: YoutubeHit[]; error?: string }>(
        `/api/tts/youtube/search?q=${encodeURIComponent(text)}`
      );
      if (!response.ok) {
        const id = parseYoutubeVideoId(text);
        if (id) {
          choose(fallbackHit(id), parseYoutubeStartSec(text));
          setResults([fallbackHit(id)]);
          return;
        }
        setError(data.error || YOUTUBE_COPY.searchUnavailable);
        return;
      }
      const hits = data.results ?? [];
      setResults(hits);
      if (hits.length === 1) choose(hits[0]!, parseYoutubeStartSec(text));
      else if (hits.length === 0) {
        const id = parseYoutubeVideoId(text);
        if (id) { choose(fallbackHit(id), parseYoutubeStartSec(text)); setResults([fallbackHit(id)]); }
        else setError(YOUTUBE_COPY.noResults);
      }
    } catch {
      const id = parseYoutubeVideoId(text);
      if (id) {
        choose(fallbackHit(id), parseYoutubeStartSec(text));
        setResults([fallbackHit(id)]);
      } else {
        setError(YOUTUBE_COPY.searchUnavailable);
      }
    } finally {
      setSearching(false);
    }
  };

  const watchClip = useCallback(async (job: PendingClip, signal: AbortSignal) => {
    let attempt = 0;
    setBusy(true);
    setMode("clip");
    callbacksRef.current.onBusy?.(true);
    try {
      while (!signal.aborted && Date.now() < job.startedAt + CLIP_CLIENT_WAIT_MS) {
        if (document.hidden) {
          await waitForClipPoll(Math.min(10_000, job.startedAt + CLIP_CLIENT_WAIT_MS - Date.now()), signal);
          continue;
        }
        try {
          const { response, data: status } = await clipJson<ClipStatus>(`/api/clips/${encodeURIComponent(job.id)}`, {}, signal, Math.min(15_000, job.startedAt + CLIP_CLIENT_WAIT_MS - Date.now()));
          if (signal.aborted) return;
          if (response.status === 404 || response.status === 401 || response.status === 403) {
            storePendingClip(null);
            setPending(null);
            setSampleUrl(null);
            setRisk(null);
            setError(YOUTUBE_COPY.clipUnavailable);
            return;
          }
          if (!response.ok) throw new Error("status unavailable");
          if (job.ownerContext && status.ownerContext !== job.ownerContext) {
            storePendingClip(null);
            setPending(null);
            setSampleUrl(null);
            setRisk(null);
            setProxyEnabled(false);
            return;
          }
          setWaitPhase(clipPhaseFromStatus(status.status, status.phase));
          setSampleUrl(status.downloadUrl || null);
          if (status.status === "ready" && status.catalogVoiceId) {
            storePendingClip(null);
            setPending(null);
            callbacksRef.current.onCloned({ catalogVoiceId: status.catalogVoiceId, displayName: clipMetadataRef.current?.displayName ?? cloneNameOrFallback(status.title ?? "YouTube voice") });
            setSelected(null);
            setResults(null);
            setQuery("");
            setConsent(false);
            return;
          }
          if (status.status === "failed") {
            storePendingClip(null);
            setPending(null);
            if (status.error === "risky_audio") {
              setRisk({
                uploadId: status.uploadId ?? job.id,
                risk: status.risk ?? status.quality ?? { headline: REFERENCE_QUALITY_COPY.failHeadline, body: REFERENCE_QUALITY_COPY.failBody, issues: [] },
                youtube: clipMetadataRef.current?.youtube ?? status.source ?? null,
                displayName: clipMetadataRef.current?.displayName ?? cloneNameOrFallback(status.title ?? "YouTube voice"),
              });
            } else if (status.requiresReview || status.error === "provider_uncertain") {
              setError(YOUTUBE_COPY.providerUncertain);
            } else setError(proxyClipErrorCopy(status.error));
            return;
          }
        } catch {
          if (signal.aborted) return;
          // Transient network failures share the same overall wall deadline.
        }
        await waitForClipPoll(Math.min(clipPollDelay(attempt++), Math.max(0, job.startedAt + CLIP_CLIENT_WAIT_MS - Date.now())), signal);
      }
      if (!signal.aborted) {
        storePendingClip(null);
        setPending(null);
        setError(proxyClipErrorCopy("timeout"));
      }
    } finally {
      if (!signal.aborted) {
        setBusy(false);
        setMode("idle");
        callbacksRef.current.onBusy?.(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    operationRef.current = controller;
    void watchClip(pending, controller.signal);
    return () => {
      controller.abort();
      setBusy(false);
      setMode("idle");
      callbacksRef.current.onBusy?.(false);
    };
  }, [pending, watchClip]);

  const submitClip = async () => {
    const requested = range ? clipRequestWindow(range.startSec, range.endSec, durationSec ?? undefined) : null;
    if (!selected || !requested || !consent || busy || disabled || !proxyEnabled) return;
    clipMetadataRef.current = {
      displayName: cloneNameOrFallback(title.trim() || selected.title),
      youtube: { videoId: selected.videoId, startSec: requested.startSeconds, endSec: requested.startSeconds + requested.lengthSeconds },
    };
    setRisk(null);
    setSampleUrl(null);
    setBusy(true);
    setMode("clip");
    setWaitPhase("starting");
    setError(null);
    onBusy?.(true);
    const controller = new AbortController();
    operationRef.current = controller;
    const startedAt = Date.now();
    try {
      const { response, data } = await clipJson<{ id?: string; code?: string }>("/api/clips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId: selected.videoId, ...requested, consent: true, title: cloneNameOrFallback(title.trim() || selected.title) }),
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.ok || !data.id) {
        if (response.status === 401 || response.status === 403) setProxyEnabled(false);
        setError(proxyClipErrorCopy(response.status === 429 ? "budget" : data.code));
        return;
      }
      const job = { id: data.id, ownerContext: ownerContext ?? "", startedAt };
      if (ownerContext) storePendingClip(job);
      setPending(job);
    } catch {
      if (!controller.signal.aborted) setError(YOUTUBE_COPY.proxyFailed);
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setMode("idle");
        onBusy?.(false);
      }
    }
  };

  const continueRisky = async () => {
    if (!risk || busy) return;
    setBusy(true);
    setMode("clone");
    setError(null);
    onBusy?.(true);
    const controller = new AbortController();
    operationRef.current = controller;
    try {
      const access = await clipJson<{ enabled?: boolean; ownerContext?: string }>("/api/clips", {}, controller.signal);
      if (controller.signal.aborted) return;
      if (!access.response.ok || !access.data.enabled || (ownerContext && access.data.ownerContext !== ownerContext)) {
        setRisk(null);
        setSampleUrl(null);
        setError(YOUTUBE_COPY.clipUnavailable);
        return;
      }
      const { response, data } = await clipJson<{ id?: string; error?: string }>(`/api/clips/${encodeURIComponent(risk.uploadId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptQualityRisk: true }),
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.ok || !data.id) throw new Error(data.error || YOUTUBE_COPY.proxyFailed);
      clipMetadataRef.current = risk.youtube ? { displayName: risk.displayName, youtube: risk.youtube } : null;
      const job = { id: data.id, ownerContext: ownerContext ?? "", startedAt: Date.now() };
      storePendingClip(job);
      setRisk(null);
      setWaitPhase("preparing");
      setPending(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : YOUTUBE_COPY.proxyFailed);
    } finally {
      setBusy(false);
      setMode("idle");
      onBusy?.(false);
    }
  };

  const duration = durationSec && durationSec >= MIN_CLIP_SEC ? durationSec : null;
  const requested = range ? clipRequestWindow(range.startSec, range.endSec, duration ?? undefined) : null;
  const rangeOk = requested != null;
  const shownStart = requested?.startSeconds ?? range?.startSec ?? 0;
  const shownEnd = requested
    ? requested.startSeconds + requested.lengthSeconds
    : (range?.endSec ?? 0);
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
            className="relative aspect-video w-full overflow-hidden rounded-sm bg-foreground/5"
          >
            <div ref={hostRef} className="absolute inset-0 h-full w-full" />
          </div>
          <a href={canonicalYoutubeUrl(selected.videoId, range?.startSec ?? linkedStartRef.current ?? undefined)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center text-sm underline">
            Open this moment on YouTube
          </a>
          {playerError ? (
            <div role="status" className="text-sm">
              <p>{YOUTUBE_COPY.previewFailed}</p>
              <button type="button" onClick={() => setPlayerAttempt((value) => value + 1)} className="min-h-12 underline">Retry player</button>
            </div>
          ) : null}
          {duration && range ? (
            <div className="space-y-2">
              <p className="text-center text-xs text-muted-foreground">
                {YOUTUBE_COPY.sampleWindow} · {formatClock(shownStart)}–
                {formatClock(shownEnd)} ({MAX_CLIP_SEC}s max)
              </p>
              <ClipRangeSlider
                startSec={range.startSec}
                endSec={range.endSec}
                durationSec={duration}
                disabled={disabled || busy}
                resetKey={`${videoId}:${Math.round(duration)}`}
                onChange={setRange}
                onCommit={(next) => seek(next.startSec)}
              />
              <div className="flex flex-wrap items-end justify-center gap-3">
                {(["start", "end"] as const).map((edge) => (
                  <label key={`${videoId}:${edge}:${edge === "start" ? shownStart : shownEnd}`} className="text-xs">
                    {edge === "start" ? "Start time" : "End time"}
                    <input
                      aria-label={edge === "start" ? "Start time" : "End time"}
                      aria-describedby={timeError ? "youtube-time-error" : undefined}
                      defaultValue={formatClock(edge === "start" ? shownStart : shownEnd)}
                      disabled={disabled || busy}
                      inputMode="numeric"
                      className="block min-h-12 w-28 border border-border/60 bg-transparent px-2 text-sm"
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
                      onBlur={(event) => {
                        const value = parseClipTime(event.target.value);
                        const next = { startSec: edge === "start" ? value ?? NaN : shownStart, endSec: edge === "end" ? value ?? NaN : shownEnd };
                        const valid = validateClipRange(next.startSec, next.endSec, duration);
                        if (!valid.ok) { setTimeError(valid.message); return; }
                        setTimeError(null);
                        setRange(next);
                        seek(next.startSec);
                      }}
                    />
                  </label>
                ))}
                <button type="button" disabled={disabled || busy || !playerReady} className="min-h-12 text-sm underline" onClick={() => {
                  const current = playerRef.current?.getCurrentTime();
                  if (current == null || !Number.isFinite(current)) return;
                  const length = shownEnd - shownStart;
                  const start = Math.max(0, Math.min(Math.round(current), Math.floor(duration) - length));
                  setRange({ startSec: start, endSec: start + length });
                  setTimeError(null);
                }}>Use current position</button>
                <button type="button" disabled={disabled || busy || !playerReady} className="min-h-12 text-sm underline" onClick={() => seek(shownStart, true)}>Play selection</button>
              </div>
              {timeError ? <p id="youtube-time-error" role="alert" className="text-sm">{timeError}</p> : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{YOUTUBE_COPY.loading}</p>
          )}
          {durationSec != null && durationSec < MIN_CLIP_SEC ? (
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
                disabled={disabled || busy || !consent || !rangeOk || !!timeError}
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

      {accessChecked && !proxyEnabled ? (
        <div role="status" className="text-sm">
          <p>{YOUTUBE_COPY.clippingUnavailable}</p>
          <button type="button" onClick={onUploadInstead} className="min-h-12 underline">{YOUTUBE_COPY.uploadInstead}</button>
        </div>
      ) : null}
      {sampleUrl ? (
        <div className="space-y-2">
          <p className="text-sm">Prepared voice sample</p>
          <audio controls preload="none" src={sampleUrl} className="w-full" aria-label="Prepared voice sample" />
        </div>
      ) : null}
      {busy && !selected ? <p role="status" className="text-sm">{clipLabel}</p> : null}
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

function rangeAtTimestamp(duration: number, timestamp: number | null): SuggestedRange | null {
  if (timestamp == null) return defaultSpeechRange(duration);
  const length = Math.min(20, Math.floor(duration));
  const start = Math.max(0, Math.min(Math.round(timestamp), Math.floor(duration) - length));
  return normalizeClipSpan(start, start + length, duration);
}
