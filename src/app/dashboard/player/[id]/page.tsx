"use client";

import { Slider } from "@/components/ui/slider";
import { Play, Pause, ArrowLeft, Loader2, List } from "lucide-react";
import React, { useState, useEffect, useRef, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import { userFriendlyError } from "@/lib/errors-ui";
import { toast } from "sonner";
import { UX } from "@/lib/ux-copy";
import { formatPlaybackSpeed, nextPlaybackSpeed } from "@/lib/player/playback-speed";

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
  warning?: string | null;
  created_at: string;
  updated_at: string;
  job_kind?: string | null;
  tts_provider?: string | null;
  stream_url?: string;
  segments?: Array<{ index: number; path: string; status: string }> | null;
  stream_chars_used?: number | null;
  stream_max_chars?: number | null;
}

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <React.Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
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
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const segmentIndexRef = useRef(0);
  const [spawningTakehome, setSpawningTakehome] = useState(false);
  const [streamEnded, setStreamEnded] = useState(false);
  const [showSections, setShowSections] = useState(false);
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

  const { initialize, resume, setSpeed, speed } = useAudioProcessor();

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

  // Initialize audio processor when audio element is ready
  useEffect(() => {
    if (audioRef.current && audioUrl && !processorInitialized.current) {
      initialize(audioRef.current);
      processorInitialized.current = true;
    }
  }, [audioUrl, initialize]);

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
      if (playAfterLoadRef.current) {
        playAfterLoadRef.current = false;
        audio.play().catch(() => {});
      }
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
          toast.message("Listening limit reached", {
            description: UX.listeningLimitReached,
          });
        } else if (j?.status === "queued" || j?.status === "ready") {
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
    };
    const onPause = () => setIsPlaying(false);
    const onError = () => {
      setIsPlaying(false);
      const isStream = forceStream || jobRef.current?.job_kind === "stream";
      if (isStream) {
        setStreamEnded(true);
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
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, [audioUrl, forceStream, id, segmentIndex]);

  const togglePlayback = async () => {
    if (!audioRef.current || !audioUrl) {
      toast.message(UX.preparingAudio);
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
      <div className="max-w-2xl mx-auto pt-8 pb-20 text-center space-y-4">
        <p className="text-sm text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={() => router.push("/dashboard/queue")}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Library
        </button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto pt-8 pb-20 font-sans">
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
        Library
      </Link>

      <div className="text-center space-y-2 mb-10">
        <h1
          className="text-4xl md:text-5xl tracking-tight text-foreground truncate px-4 font-serif"
          style={{ fontWeight: 300 }}
        >
          {job.book_title}
        </h1>
        {job.voice_name ? (
          <p className="text-sm text-muted-foreground font-serif">{job.voice_name}</p>
        ) : null}
        {job.status !== "failed" && !audioUrl ? (
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {UX.preparingAudio}
          </p>
        ) : (job.status === "processing" || job.status === "queued") &&
          job.progress < 100 ? (
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {UX.generating}
          </p>
        ) : null}
        {job.status === "failed" ? (
          <p className="text-xs text-muted-foreground" role="alert">
            {job.error_message
              ? userFriendlyError(job.error_message)
              : UX.failed}
          </p>
        ) : job.warning ? (
          <p className="text-xs text-muted-foreground" role="status">
            {userFriendlyError(String(job.warning))}
          </p>
        ) : null}
      </div>

      {(forceStream || job.job_kind === "stream") && (
        <div className="mb-8 text-center space-y-2">
          {streamEnded ? (
            <p className="text-xs text-muted-foreground">{UX.listeningPaused}</p>
          ) : null}
          <button
            type="button"
            disabled={spawningTakehome}
            onClick={handleSpawnTakehome}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            {spawningTakehome ? UX.fullBookStarted : UX.saveFullBook}
          </button>
        </div>
      )}

      <div className="flex flex-col items-center gap-8 mb-8">
        <button
          type="button"
          onClick={togglePlayback}
          disabled={!audioUrl}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="text-foreground hover:opacity-70 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {isPlaying ? (
            <Pause aria-hidden="true" className="w-8 h-8" />
          ) : (
            <Play aria-hidden="true" className="w-8 h-8 ml-0.5" />
          )}
        </button>

        {audioUrl ? (
          <>
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
                className={`w-full ${isStreamMode ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
                <span>{formatTime(currentTime)}</span>
                <span>{isStreamMode ? "—" : formatTime(duration)}</span>
              </div>
            </div>
            <button
              type="button"
              aria-label={`Playback speed ${speed}x, tap to change`}
              onClick={() => {
                const next = nextPlaybackSpeed(speed);
                setSpeed(next);
                if (audioRef.current) audioRef.current.playbackRate = next;
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {formatPlaybackSpeed(speed)}
            </button>
          </>
        ) : null}
      </div>

      {/* Segment playlist for takehome jobs */}
      {job.segments?.some((s) => s.status === "ready") &&
        !forceStream &&
        job.job_kind !== "stream" && (
        <div className="mt-6">
          <button
            type="button"
            aria-expanded={showSections}
            onClick={() => setShowSections(!showSections)}
            className="w-full py-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              <List className="w-3.5 h-3.5" />
              {showSections ? "Hide sections" : "Sections"}
            </span>
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
        <div className="mt-10 text-center">
          <button
            type="button"
            onClick={handleDownload}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Download
          </button>
        </div>
      )}
    </div>
  );
}
