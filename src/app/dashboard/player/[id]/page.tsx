"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Play, Pause, SkipBack, SkipForward, Download, Volume2,
  ArrowLeft, Loader2, List, Clock, Headphones, Sparkles,
} from "lucide-react";
import React, { useState, useEffect, useRef, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import { userFriendlyError } from "@/lib/errors-ui";
import { toast } from "sonner";
import { UX } from "@/lib/ux-copy";
import { PLAYBACK_SPEED_PRESETS } from "@/lib/player/playback-speed";

function readyByIndex(
  segments: Array<{ index: number; path: string; status: string }> | null | undefined
): Map<number, { index: number; path: string; status: string }> {
  const map = new Map<number, { index: number; path: string; status: string }>();
  for (const s of segments || []) {
    if (s.status === "ready" && s.path) map.set(s.index, s);
  }
  return map;
}

function canPlayIndex(
  segments: Array<{ index: number; path: string; status: string }> | null | undefined,
  index: number
): boolean {
  const ready = readyByIndex(segments);
  for (let i = 0; i <= index; i++) {
    if (!ready.has(i)) return false;
  }
  return true;
}

interface Job {
  id: string;
  book_title: string;
  voice_name: string | null;
  status: "queued" | "processing" | "ready" | "failed" | "cancelled";
  progress: number;
  current_section: number;
  total_sections: number;
  audio_url?: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  job_kind?: string | null;
  tts_provider?: string | null;
  stream_url?: string;
  segments?: Array<{ index: number; path: string; status: string }> | null;
  stream_chars_used?: number | null;
  stream_max_chars?: number | null;
  eta_seconds?: number | null;
  eta_label?: string | null;
  elapsed_seconds?: number | null;
  elapsed_label?: string | null;
}

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <React.Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      }
    >
      <PlayerPageInner params={params} />
    </React.Suspense>
  );
}

function PlayerPageInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const forceStream = searchParams.get("mode") === "stream";
  const forceSegments = searchParams.get("mode") === "segments";
  const audioRef = useRef<HTMLAudioElement>(null);
  const processorInitialized = useRef(false);

  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(75);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const segmentIndexRef = useRef(0);
  const [spawningTakehome, setSpawningTakehome] = useState(false);
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);
  const [streamEnded, setStreamEnded] = useState(false);
  const [showSections, setShowSections] = useState(false);
  const [streamPhase, setStreamPhase] = useState<
    "idle" | "opening" | "preparing" | "buffering" | "playing" | "continuing"
  >("idle");
  const [warmHint, setWarmHint] = useState(false);
  const playAfterLoadRef = useRef(false);
  const waitingForNextRef = useRef(false);

  // Reset all audio state when audiobook id changes
  useEffect(() => {
    setJob(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setAudioUrl(null);
    setError(null);
    processorInitialized.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current.load();
    }
  }, [id]);

  // Use ref for isDragging to avoid effect re-registration
  const isDraggingRef = useRef(false);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const { initialize, resume, setSpeed, setVolume, speed } = useAudioProcessor();

  // Fetch job data via REST API
  useEffect(() => {
    async function fetchJob() {
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) throw new Error("Failed to fetch job");
        const data = await response.json();
        const j = data.job as Job;
        setJob(j);

        const isStream = forceStream || j.job_kind === "stream";
        if (isStream) {
          setStreamPhase("opening");
          setWarmHint(false);
          setAudioUrl(j.stream_url || `/api/jobs/${id}/stream`);
          return;
        }

        const first = readyByIndex(j.segments).get(0);
        if (first && (forceSegments || j.status === "processing" || !j.audio_url)) {
          setAudioUrl(`/api/storage/${first.path}`);
          setSegmentIndex(0);
          return;
        }

        if (j.audio_url) {
          setAudioUrl(j.audio_url);
        } else if (first) {
          setAudioUrl(`/api/storage/${first.path}`);
          setSegmentIndex(0);
        }
      } catch (err) {
        console.error("Failed to fetch job:", err);
        setError("Failed to load audiobook");
      }
    }

    fetchJob();
  }, [id, forceStream, forceSegments]);

  const audioUrlRef = useRef(audioUrl);
  useEffect(() => { audioUrlRef.current = audioUrl; }, [audioUrl]);

  // Polling for updates (every 3 seconds) - only re-render if data actually changed
  const jobRef = useRef<Job | null>(null);
  useEffect(() => { jobRef.current = job; }, [job]);
  useEffect(() => { segmentIndexRef.current = segmentIndex; }, [segmentIndex]);

  const jobStatus = job?.status;
  const jobKind = job?.job_kind;
  useEffect(() => {
    if (!jobStatus) return;
    const isStream = forceStream || jobKind === "stream";
    // Poll take-home while generating; also poll streams for budget/status.
    if (
      !isStream &&
      (jobStatus === "ready" ||
        jobStatus === "failed" ||
        jobStatus === "cancelled")
    ) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) return;
        const data = await response.json();
        const prev = jobRef.current;
        const next = data.job as Job;

        if (!prev ||
            prev.status !== next.status ||
            prev.progress !== next.progress ||
            prev.current_section !== next.current_section ||
            prev.total_sections !== next.total_sections ||
            prev.audio_url !== next.audio_url ||
            prev.error_message !== next.error_message ||
            prev.duration_seconds !== next.duration_seconds ||
            prev.stream_chars_used !== next.stream_chars_used ||
            prev.stream_max_chars !== next.stream_max_chars ||
            prev.eta_label !== next.eta_label ||
            prev.elapsed_label !== next.elapsed_label ||
            JSON.stringify(prev.segments) !== JSON.stringify(next.segments)) {
          setJob(next);
        }

        if (isStream) {
          const used = next.stream_chars_used ?? 0;
          const max = next.stream_max_chars ?? 0;
          if (max > 0 && used >= max) {
            setStreamEnded(true);
          }
          return;
        }

        if (next.audio_url && !audioUrlRef.current) {
          setAudioUrl(next.audio_url);
        } else if (!audioUrlRef.current) {
          const first = readyByIndex(next.segments).get(0);
          if (first) {
            setSegmentIndex(0);
            setAudioUrl(`/api/storage/${first.path}`);
          }
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [id, jobStatus, jobKind, forceStream]);

  useEffect(() => {
    if (!waitingForNextRef.current || !job?.segments) return;
    const nextIndex = segmentIndex + 1;
    const next = readyByIndex(job.segments).get(nextIndex);
    if (next && canPlayIndex(job.segments, nextIndex)) {
      waitingForNextRef.current = false;
      setSegmentIndex(nextIndex);
      playAfterLoadRef.current = true;
      setAudioUrl(`/api/storage/${next.path}`);
    }
  }, [job, segmentIndex]);

  const handleSpawnTakehome = async () => {
    setSpawningTakehome(true);
    try {
      const res = await fetch(`/api/jobs/${id}/takehome`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      toast.success(UX.fullBookStarted);
      // Stay with the new take-home job so progress is visible immediately.
      router.push(`/dashboard/player/${data.jobId}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSpawningTakehome(false);
    }
  };

  // Sleep timer countdown
  useEffect(() => {
    if (!sleepTimer) return;
    const interval = setInterval(() => {
      setSleepRemaining((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          audioRef.current?.pause();
          setSleepTimer(null);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [sleepTimer]);

  // Initialize audio processor when audio element is ready
  useEffect(() => {
    if (audioRef.current && audioUrl && !processorInitialized.current) {
      initialize(audioRef.current);
      processorInitialized.current = true;
    }
  }, [audioUrl, initialize]);

  // Soft hint if first audio takes a while
  useEffect(() => {
    const isStream = forceStream || job?.job_kind === "stream";
    if (!isStream || isPlaying || streamEnded) {
      setWarmHint(false);
      return;
    }
    if (streamPhase !== "opening" && streamPhase !== "preparing" && streamPhase !== "buffering") {
      return;
    }
    const t = setTimeout(() => setWarmHint(true), 12_000);
    return () => clearTimeout(t);
  }, [forceStream, job?.job_kind, isPlaying, streamEnded, streamPhase]);

  // Sync volume with processor AND native element (processor may fail to init)
  useEffect(() => {
    setVolume(volume);
    if (audioRef.current) {
      audioRef.current.volume = Math.min(1, Math.max(0, volume / 100));
    }
  }, [volume, setVolume]);

  // Audio event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      if (!isDraggingRef.current) setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onLoadedMetadata = () => setDuration(audio.duration || 0);
    const onCanPlay = () => {
      setStreamPhase((p) => (p === "playing" ? p : "preparing"));
      if (playAfterLoadRef.current) {
        playAfterLoadRef.current = false;
        audio.play().catch(() => {});
      }
    };
    const onWaiting = () => {
      setStreamPhase((p) => (p === "playing" || p === "continuing" ? "buffering" : p));
    };
    const onPlaying = () => {
      setStreamPhase("playing");
      setWarmHint(false);
    };
    const onLoadStart = () => {
      setStreamPhase((p) =>
        p === "continuing" || p === "playing" ? "continuing" : "opening"
      );
    };
    const onEnded = () => {
      setIsPlaying(false);
      const isStream = forceStream || jobRef.current?.job_kind === "stream";
      if (isStream) {
        const j = jobRef.current;
        const used = j?.stream_chars_used ?? 0;
        const max = j?.stream_max_chars ?? 0;
        if (max > 0 && used >= max) {
          setStreamEnded(true);
          setStreamPhase("idle");
          toast.message("Listening limit reached", {
            description: UX.listeningLimitReached,
          });
        } else if (j?.status === "queued" || j?.status === "ready") {
          setStreamPhase("continuing");
          toast.message(UX.continuing);
          const nextUrl = `/api/jobs/${id}/stream?t=${Date.now()}`;
          playAfterLoadRef.current = true;
          setAudioUrl(nextUrl);
        }
        return;
      }
      if (jobRef.current?.segments?.length) {
        const current = segmentIndexRef.current;
        const nextIndex = current + 1;
        const next = readyByIndex(jobRef.current.segments).get(nextIndex);
        if (next && canPlayIndex(jobRef.current.segments, nextIndex)) {
          waitingForNextRef.current = false;
          setSegmentIndex(nextIndex);
          playAfterLoadRef.current = true;
          setAudioUrl(`/api/storage/${next.path}`);
        } else {
          waitingForNextRef.current = true;
        }
      }
    };
    const onPlay = () => {
      setIsPlaying(true);
      setStreamPhase("playing");
    };
    const onPause = () => setIsPlaying(false);
    const onError = () => {
      setIsPlaying(false);
      const isStream = forceStream || jobRef.current?.job_kind === "stream";
      if (isStream) {
        setStreamEnded(true);
        setStreamPhase("idle");
        toast.error("Listening stopped", {
          description: "Save the full audiobook, or try listening again.",
        });
      } else {
        toast.error("Couldn't play this audio. Try another section or regenerate.");
      }
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("loadstart", onLoadStart);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("loadstart", onLoadStart);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, [audioUrl, forceStream, id, segmentIndex]);

  const togglePlayback = async () => {
    if (!audioRef.current || !audioUrl) {
      toast.message(UX.preparingAudio, {
        description: "Wait for the first section, or try a chapter from Voices.",
      });
      return;
    }

    // Resume audio context if suspended (browser policy)
    await resume();

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      try {
        await audioRef.current.play();
      } catch {
        toast.error("Playback was blocked by the browser. Tap play again.");
      }
    }
  };

  const isStreamMode = forceStream || job?.job_kind === "stream";

  const handleSeekChange = (value: number[]) => {
    if (isStreamMode) return;
    setIsDragging(true);
    setCurrentTime(value[0] ?? 0);
  };

  const handleSeekCommit = (value: number[]) => {
    if (isStreamMode) {
      setIsDragging(false);
      return;
    }
    const seekTo = value[0] ?? 0;
    if (audioRef.current) {
      audioRef.current.currentTime = seekTo;
      if (isPlaying) {
        audioRef.current.play().catch(() => {});
      }
    }
    setIsDragging(false);
  };

  const handleSkipBack = () => {
    if (isStreamMode || !audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
  };

  const handleSkipForward = () => {
    if (isStreamMode || !audioRef.current) return;
    audioRef.current.currentTime = Math.min(duration, audioRef.current.currentTime + 10);
  };

  const handleDownload = async () => {
    if (!job) return;
    try {
      const { downloadFromUrl, audiobookFilename } = await import(
        "@/lib/download-client"
      );
      toast.message("Preparing full audiobook…");
      await downloadFromUrl(
        `/api/jobs/${job.id}/download`,
        audiobookFilename(job.book_title)
      );
      toast.success("Download started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download");
    }
  };

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  if (error) {
    return (
      <div className="max-w-2xl mx-auto pt-8 pb-20 text-center">
        <p className="text-destructive">{error}</p>
        <Button
          variant="outline"
          onClick={() => router.push("/dashboard/queue")}
          className="mt-4"
        >
          Back to library
        </Button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto pt-8 pb-20">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
        />
      )}

      {/* Back button */}
      <Link
        href="/dashboard/queue"
        className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8"
      >
        <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
        Back to library
      </Link>

      {/* Header */}
      <div className="text-center space-y-3 mb-6">
        <h1 className="text-4xl md:text-5xl tracking-tight text-foreground truncate px-4 font-serif" style={{ fontWeight: 300 }}>{job.book_title}</h1>
        <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground flex-wrap">
          <span className="font-serif">{job.voice_name}</span>
          {(forceStream || job.job_kind === "stream") && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-sm bg-[#D97757]/10 text-[#D97757]">
              <Headphones className="w-3 h-3" /> {UX.listening}
            </span>
          )}
          {job.job_kind === "takehome" && (
            <span className="text-xs px-2 py-0.5 rounded-sm bg-accent">{UX.savedBook}</span>
          )}
          {job.tts_provider && (
            <span className="text-[10px] uppercase tracking-wider">{job.tts_provider}</span>
          )}
        </div>
      </div>

      {/* Processing status — prominent when generating */}
      {(job.status === "processing" || job.status === "queued") &&
        job.progress < 100 && (
        <div
          className="mb-6 p-4 rounded-sm border border-[#D97757]/30 bg-[#D97757]/5"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <Loader2 aria-hidden="true" className="w-5 h-5 text-[#D97757] animate-spin shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-[#D97757]">
                {job.status === "queued" && job.progress === 0
                  ? "Starting generation…"
                  : `Generating… ${job.segments?.filter((s) => s.status === "ready").length ?? job.current_section} of ${job.total_sections || "…"} ready`}
                {job.elapsed_label ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {job.elapsed_label} elapsed
                  </span>
                ) : null}
                {job.eta_label ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {job.eta_label} left
                  </span>
                ) : null}
              </p>
              <div
                className="mt-2 h-1.5 w-full bg-accent rounded-full overflow-hidden"
                role="progressbar"
                aria-label="Audiobook generation progress"
                aria-valuenow={job.progress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full bg-[#D97757] transition-all duration-500"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-1">
                <p className="text-[10px] text-muted-foreground">
                  {job.segments?.some((s) => s.status === "ready")
                    ? "Ready sections available to listen now"
                    : job.current_section === 0
                      ? "Short books often finish in under a minute"
                      : "Synthesizing…"}
                </p>
                <p className="text-[10px] text-muted-foreground font-mono">{job.progress}%</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {job.status === "failed" && (
        <div
          className="mb-6 p-4 rounded-xl border border-destructive/30 bg-destructive/5"
          role="alert"
        >
          <p className="text-sm font-medium text-destructive">Generation failed</p>
          {job.error_message && (
            <p className="text-xs text-muted-foreground mt-1">{userFriendlyError(job.error_message)}</p>
          )}
        </div>
      )}

      {/* Chapter listening banner */}
      {(forceStream || job.job_kind === "stream") && (
        <div className="mb-6 p-4 rounded-sm border border-border/50 bg-accent/30">
          <div className="flex items-center gap-2 text-sm mb-2">
            <Headphones className="w-4 h-4 text-[#D97757]" />
            <span className="font-medium font-serif">{UX.tryChapter}</span>
            <span className="text-xs text-muted-foreground">· about an hour of listening</span>
          </div>
          {streamEnded && (
            <p className="text-xs text-[#D97757] mb-3">{UX.listeningPaused}</p>
          )}
          {job.stream_chars_used != null && job.stream_max_chars != null && (
            <div className="mb-3">
              <div
                className="h-1 w-full bg-accent rounded-full overflow-hidden"
                role="progressbar"
                aria-label="Listening time used"
                aria-valuenow={Math.round(
                  (job.stream_chars_used / job.stream_max_chars) * 100
                )}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full bg-[#D97757] transition-all"
                  style={{ width: `${Math.min(100, (job.stream_chars_used / job.stream_max_chars) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1 text-right">
                {Math.round((job.stream_chars_used / job.stream_max_chars) * 100)}% {UX.listeningTimeUsed.toLowerCase()}
              </p>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={spawningTakehome}
            onClick={handleSpawnTakehome}
            className="w-full gap-2"
          >
            {spawningTakehome ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {UX.saveFullBook}
          </Button>
        </div>
      )}

      {/* First-audio stages for chapter listening */}
      {(forceStream || job.job_kind === "stream") &&
        !isPlaying &&
        !streamEnded &&
        (streamPhase === "opening" ||
          streamPhase === "preparing" ||
          streamPhase === "buffering" ||
          streamPhase === "continuing") && (
          <div
            className="mb-6 p-4 rounded-sm border border-[#D97757]/30 bg-[#D97757]/5"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3">
              <Loader2 aria-hidden="true" className="w-5 h-5 text-[#D97757] animate-spin shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-[#D97757]">
                  {streamPhase === "opening"
                    ? UX.openingBook
                    : streamPhase === "continuing"
                      ? UX.continuing
                      : streamPhase === "buffering"
                        ? UX.almostReady
                        : UX.preparingNarrator}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {warmHint ? UX.stillWarming : "Sound usually starts within a few seconds."}
                </p>
              </div>
            </div>
          </div>
        )}

      {/* Play button — large, centered */}
      <div className="flex flex-col items-center gap-6 mb-8">
        <button
          type="button"
          onClick={togglePlayback}
          disabled={!audioUrl}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="w-20 h-20 rounded-full bg-primary hover:bg-primary/90 flex items-center justify-center transition-all hover:scale-105 text-primary-foreground shadow-lg disabled:opacity-40 disabled:hover:scale-100 disabled:cursor-not-allowed"
        >
          {isPlaying ? (
            <Pause aria-hidden="true" className="w-8 h-8" />
          ) : (
            <Play aria-hidden="true" className="w-8 h-8 ml-1" />
          )}
        </button>
        {!audioUrl && (
          <p className="text-xs text-muted-foreground">{UX.preparingAudio}</p>
        )}

        {/* Progress bar */}
        <div className="w-full space-y-2">
          <Slider
            aria-label="Seek position"
            value={[currentTime]}
            onValueChange={handleSeekChange}
            onValueCommit={handleSeekCommit}
            min={0}
            max={duration || 1}
            step={0.1}
            disabled={isStreamMode}
            className={`w-full ${isStreamMode ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
            <span>{formatTime(currentTime)}</span>
            <span className="text-[10px] uppercase tracking-wider">
              {isStreamMode
                ? UX.seekingUnavailable
                : job.total_sections
                  ? `Section ${segmentIndex + 1} of ${job.total_sections}`
                  : job.segments && job.segments.length > 1
                    ? `Section ${segmentIndex + 1}`
                    : ""}
            </span>
            <span>{isStreamMode ? "—" : formatTime(duration)}</span>
          </div>
        </div>

        {/* Skip controls + speed presets */}
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={handleSkipBack}
            disabled={isStreamMode}
            className="w-10 h-10 text-muted-foreground hover:text-foreground rounded-full"
            aria-label="Back 10 seconds"
            title="Back 10s"
          >
            <SkipBack className="w-4 h-4" />
          </Button>

          {PLAYBACK_SPEED_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={speed === preset}
              aria-label={`Playback speed ${preset}x`}
              onClick={() => {
                setSpeed(preset);
                if (audioRef.current) audioRef.current.playbackRate = preset;
              }}
              className={`px-3 py-1.5 text-xs rounded-full transition-all ${
                speed === preset
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-accent text-muted-foreground hover:text-foreground"
              }`}
            >
              {preset}x
            </button>
          ))}

          <Button
            size="icon"
            variant="ghost"
            onClick={handleSkipForward}
            disabled={isStreamMode}
            className="w-10 h-10 text-muted-foreground hover:text-foreground rounded-full"
            aria-label="Forward 10 seconds"
            title="Forward 10s"
          >
            <SkipForward className="w-4 h-4" />
          </Button>
        </div>

        {/* Volume + sleep timer */}
        <div className="flex items-center gap-4 w-full max-w-xs">
          <Volume2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <Slider
            aria-label="Volume"
            value={[volume]}
            onValueChange={(value) => setVolumeState(value[0] ?? 100)}
            min={0}
            max={100}
            step={1}
            className="flex-1 cursor-pointer"
          />
          <span className="text-xs text-muted-foreground w-8 text-right font-mono">{volume}%</span>
          <div className="relative shrink-0">
            <button
              type="button"
              aria-label={
                sleepRemaining
                  ? `Sleep timer running, ${Math.ceil(sleepRemaining / 60)} minutes left`
                  : "Set sleep timer"
              }
              onClick={() => {
                const opts = [null, 300, 600, 1800];
                const idx = opts.indexOf(sleepTimer);
                const next = opts[(idx + 1) % opts.length] ?? null;
                setSleepTimer(next);
                setSleepRemaining(next);
              }}
              className={`p-1.5 rounded-full transition-colors ${
                sleepTimer ? "text-[#D97757] bg-[#D97757]/10" : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
              title={sleepRemaining ? `Sleep in ${Math.floor(sleepRemaining / 60)}m ${sleepRemaining % 60}s` : "Sleep timer"}
            >
              <Clock className="w-4 h-4" />
            </button>
            {sleepRemaining != null && (
              <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[10px] text-[#D97757] whitespace-nowrap font-mono">
                {Math.floor(sleepRemaining / 60)}:{String(sleepRemaining % 60).padStart(2, "0")}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Segment playlist for takehome jobs */}
      {job.segments && job.segments.length > 0 && !forceStream && job.job_kind !== "stream" && (
        <div className="mt-6">
          <button
            type="button"
            aria-expanded={showSections}
            onClick={() => setShowSections(!showSections)}
            className="w-full flex items-center justify-between py-3 text-xs text-muted-foreground hover:text-foreground transition-colors border-t border-border/50"
          >
            <span className="flex items-center gap-2">
              <List className="w-3.5 h-3.5" />
              {showSections ? "Hide sections" : `Sections (${job.segments.filter(s => s.status === "ready").length} ready)`}
            </span>
            {job.status === "processing" && (
              <span className="text-[#D97757]">
                {job.segments?.filter((s) => s.status === "ready").length ?? 0} / {job.total_sections} ready
              </span>
            )}
          </button>

          {showSections && (
            <div className="max-h-64 overflow-y-auto space-y-1 border border-border/50 rounded-lg p-2 mt-2">
              {Array.from({ length: job.total_sections || job.segments.length }, (_, index) => {
                const seg = [...job.segments!]
                  .sort((a, b) => a.index - b.index)
                  .find((s) => s.index === index);
                const isReady = Boolean(seg && seg.status === "ready" && canPlayIndex(job.segments, index));
                const isCurrent = seg ? audioUrl?.includes(seg.path) : false;
                return (
                    <button
                      key={index}
                      onClick={() => {
                        if (isReady && seg) {
                          setSegmentIndex(index);
                          playAfterLoadRef.current = true;
                          setAudioUrl(`/api/storage/${seg.path}`);
                        }
                      }}
                      disabled={!isReady}
                      className={`w-full text-left px-3 py-2.5 rounded text-sm transition-all flex items-center gap-3 ${
                        isCurrent
                          ? "bg-primary/10 text-primary font-medium"
                          : isReady
                            ? "text-muted-foreground hover:text-foreground hover:bg-accent"
                            : "text-muted-foreground/40 cursor-not-allowed"
                      }`}
                    >
                      <span className="font-mono text-xs w-8">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="flex-1">
                        {isReady ? "Section ready" : "Generating…"}
                      </span>
                      {isCurrent && isPlaying && (
                        <span className="flex gap-0.5 items-end h-3">
                          <span className="w-0.5 h-2 bg-primary animate-pulse" />
                          <span className="w-0.5 h-3 bg-primary animate-pulse" style={{ animationDelay: "0.15s" }} />
                          <span className="w-0.5 h-1.5 bg-primary animate-pulse" style={{ animationDelay: "0.3s" }} />
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Download button — ready jobs or any with ready segments */}
      {(job.status === "ready" || job.segments?.some((s) => s.status === "ready")) &&
        job.job_kind !== "stream" && (
        <Button
          variant="outline"
          onClick={handleDownload}
          className="w-full mt-8 h-12 rounded-full border-border/50 hover:bg-accent hover:text-foreground transition-all flex items-center justify-center gap-2"
        >
          <Download className="w-4 h-4" />
          Download audiobook
        </Button>
      )}
    </div>
  );
}
