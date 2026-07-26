"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Play, Pause, SkipBack, SkipForward, Download, Volume2,
  ArrowLeft, Loader2, List, Clock, Headphones, Sparkles,
} from "lucide-react";
import React, { useState, useEffect, useRef, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import { userFriendlyError } from "@/lib/errors-ui";
import { toast } from "sonner";

interface Job {
  id: string;
  book_title: string;
  voice_name: string | null;
  status: "queued" | "processing" | "ready" | "failed";
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
  chapters?: Array<{ title: string; startTime: number; sectionIndex: number }>;
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
  const [showChapters, setShowChapters] = useState(false);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [spawningTakehome, setSpawningTakehome] = useState(false);
  const [sleepTimer, setSleepTimer] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);

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

  // Audio processor hook
  const {
    initialize, resume, setSpeed, setPitch, setDepth, setDynamics, setVolume,
    isReady: processorReady, controls
  } = useAudioProcessor();

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

        const readySegments = (j.segments || [])
          .filter((s) => s.status === "ready")
          .sort((a, b) => a.index - b.index);

        if ((forceSegments || j.status === "processing") && readySegments.length > 0) {
          setAudioUrl(`/api/storage/${readySegments[0]!.path}`);
          setSegmentIndex(0);
          return;
        }

        if (j.audio_url) {
          setAudioUrl(j.audio_url);
        } else if (readySegments.length > 0) {
          setAudioUrl(`/api/storage/${readySegments[0]!.path}`);
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

  useEffect(() => {
    if (!job || job.status === "ready" || job.job_kind === "stream") return;

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) return;
        const data = await response.json();
        const prev = jobRef.current;
        const next = data.job as Job;

        // Only update state if something meaningful changed
        if (!prev ||
            prev.status !== next.status ||
            prev.progress !== next.progress ||
            prev.current_section !== next.current_section ||
            prev.total_sections !== next.total_sections ||
            prev.audio_url !== next.audio_url ||
            prev.error_message !== next.error_message ||
            prev.duration_seconds !== next.duration_seconds ||
            JSON.stringify(prev.segments) !== JSON.stringify(next.segments)) {
          setJob(next);
        }

        if (next.audio_url && !audioUrlRef.current) {
          setAudioUrl(next.audio_url);
        } else if (!audioUrlRef.current && next.segments?.length) {
          const first = next.segments
            .filter((s) => s.status === "ready")
            .sort((a, b) => a.index - b.index)[0];
          if (first) setAudioUrl(`/api/storage/${first.path}`);
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [id, job?.status, job?.job_kind]);

  const handleSpawnTakehome = async () => {
    setSpawningTakehome(true);
    try {
      const res = await fetch(`/api/jobs/${id}/takehome`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      toast.success("Full audiobook generation started");
      router.push("/dashboard/queue");
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

  // Sync volume with processor
  useEffect(() => {
    setVolume(volume);
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
    const onEnded = () => {
      setIsPlaying(false);
      // Advance multi-segment take-home playlist
      if (jobRef.current?.segments?.length) {
        const ready = jobRef.current.segments
          .filter((s) => s.status === "ready")
          .sort((a, b) => a.index - b.index);
        const idx = ready.findIndex((s) =>
          audioUrlRef.current?.includes(s.path)
        );
        const next = ready[idx >= 0 ? idx + 1 : segmentIndex + 1];
        if (next) {
          setSegmentIndex(idx >= 0 ? idx + 1 : segmentIndex + 1);
          setAudioUrl(`/api/storage/${next.path}`);
          setTimeout(() => {
            audioRef.current?.play().catch(() => {});
          }, 100);
        }
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [audioUrl]);

  const togglePlayback = async () => {
    if (!audioRef.current) return;

    // Resume audio context if suspended (browser policy)
    await resume();

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      try {
        await audioRef.current.play();
      } catch {
        // play() failed (e.g. browser autoplay policy) — keep isPlaying false
      }
    }
  };

  const handleSeekChange = (value: number[]) => {
    setIsDragging(true);
    setCurrentTime(value[0] ?? 0);
  };

  const handleSeekCommit = (value: number[]) => {
    const seekTo = value[0] ?? 0;
    if (audioRef.current) {
      audioRef.current.currentTime = seekTo;
      // If audio was playing, continue playing from new position
      if (isPlaying) {
        audioRef.current.play().catch(() => {});
      }
    }
    setIsDragging(false);
  };

  const handleSkipBack = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
    }
  };

  const handleSkipForward = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.min(duration, audioRef.current.currentTime + 10);
    }
  };

  const handleDownload = () => {
    if (!job) return;
    // H10: Use dedicated download endpoint that concatenates all segments
    const downloadUrl = `/api/jobs/${job.id}/download`;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Control handlers
  const handleSpeedChange = (value: number[]) => {
    const speed = value[0] ?? 1;
    setSpeed(speed);
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
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
      <button
        onClick={() => router.push("/dashboard/queue")}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to queue
      </button>

      {/* Header */}
      <div className="text-center space-y-3 mb-6">
        <h1 className="text-4xl md:text-5xl tracking-tight text-foreground truncate px-4 font-serif" style={{ fontWeight: 300 }}>{job.book_title}</h1>
        <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground flex-wrap">
          <span className="font-serif">{job.voice_name}</span>
          {(forceStream || job.job_kind === "stream") && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[#D97757]/10 text-[#D97757]">
              <Headphones className="w-3 h-3" /> Live stream
            </span>
          )}
          {job.job_kind === "takehome" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-accent">Take-home</span>
          )}
          {job.tts_provider && (
            <span className="text-[10px] uppercase tracking-wider">{job.tts_provider}</span>
          )}
        </div>
      </div>

      {/* Processing status — prominent when generating */}
      {job.status === "processing" && (
        <div className="mb-6 p-4 rounded-xl border border-[#D97757]/30 bg-[#D97757]/5">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-[#D97757] animate-spin shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-[#D97757]">
                Generating… Section {job.current_section + 1} of {job.total_sections}
              </p>
              <div className="mt-2 h-1.5 w-full bg-accent rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#D97757] transition-all duration-500"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-1">
                <p className="text-[10px] text-muted-foreground">
                  {job.segments?.some(s => s.status === "ready") ? "Ready sections available to listen now" : "Synthesizing…"}
                </p>
                <p className="text-[10px] text-muted-foreground font-mono">{job.progress}%</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {job.status === "failed" && (
        <div className="mb-6 p-4 rounded-xl border border-destructive/30 bg-destructive/5">
          <p className="text-sm font-medium text-destructive">Generation failed</p>
          {job.error_message && (
            <p className="text-xs text-muted-foreground mt-1">{userFriendlyError(job.error_message)}</p>
          )}
        </div>
      )}

      {/* Stream mode — generate full copy CTA */}
      {(forceStream || job.job_kind === "stream") && (
        <div className="mb-6 p-4 rounded-xl border border-border/50 bg-accent/30">
          <div className="flex items-center gap-2 text-sm mb-2">
            <Headphones className="w-4 h-4 text-[#D97757]" />
            <span className="font-medium">Live listen</span>
            <span className="text-xs text-muted-foreground">· ~1h cap</span>
          </div>
          {job.stream_chars_used != null && job.stream_max_chars != null && (
            <div className="mb-3">
              <div className="h-1 w-full bg-accent rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#D97757] transition-all"
                  style={{ width: `${Math.min(100, (job.stream_chars_used / job.stream_max_chars) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1 text-right">
                {Math.round((job.stream_chars_used / job.stream_max_chars) * 100)}% of stream budget
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
            Generate full take-home copy
          </Button>
        </div>
      )}

      {/* Play button — large, centered */}
      <div className="flex flex-col items-center gap-6 mb-8">
        <button
          onClick={togglePlayback}
          className="w-20 h-20 rounded-full bg-primary hover:bg-primary/90 flex items-center justify-center transition-all hover:scale-105 text-primary-foreground shadow-lg"
        >
          {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
        </button>

        {/* Progress bar */}
        <div className="w-full space-y-2">
          <Slider
            value={[currentTime]}
            onValueChange={handleSeekChange}
            onValueCommit={handleSeekCommit}
            min={0}
            max={duration || 1}
            step={0.1}
            className="w-full cursor-pointer"
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Skip controls + speed presets */}
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={handleSkipBack}
            className="w-10 h-10 text-muted-foreground hover:text-foreground rounded-full"
            title="Back 10s"
          >
            <SkipBack className="w-4 h-4" />
          </Button>

          {[1, 1.25, 1.5, 2].map((speed) => (
            <button
              key={speed}
              onClick={() => {
                setSpeed(speed);
                if (audioRef.current) audioRef.current.playbackRate = speed;
              }}
              className={`px-3 py-1.5 text-xs rounded-full transition-all ${
                controls.speed === speed
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-accent text-muted-foreground hover:text-foreground"
              }`}
            >
              {speed}x
            </button>
          ))}

          <Button
            size="icon"
            variant="ghost"
            onClick={handleSkipForward}
            className="w-10 h-10 text-muted-foreground hover:text-foreground rounded-full"
            title="Forward 10s"
          >
            <SkipForward className="w-4 h-4" />
          </Button>
        </div>

        {/* Volume + sleep timer */}
        <div className="flex items-center gap-4 w-full max-w-xs">
          <Volume2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <Slider
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
              title={sleepRemaining ? `Sleep in ${Math.floor(sleepRemaining / 60)}m` : "Sleep timer"}
            >
              <Clock className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Chapter navigation */}
      {job?.chapters && job.chapters.length > 0 && (
        <>
          <button
            onClick={() => setShowChapters(!showChapters)}
            className="w-full flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground hover:text-foreground transition-colors border-t border-border/50"
          >
            <List className="w-3.5 h-3.5" />
            {showChapters ? "Hide chapters" : `Chapters (${job.chapters.length})`}
          </button>

          {showChapters && (
            <div className="max-h-48 overflow-y-auto space-y-1 border border-border/50 rounded-lg p-2">
              {job.chapters.map((chapter, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    if (audioRef.current) {
                      audioRef.current.currentTime = chapter.startTime;
                      setCurrentTime(chapter.startTime);
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                    currentTime >= chapter.startTime && (idx === job.chapters!.length - 1 || currentTime < (job.chapters![idx + 1]?.startTime ?? Infinity))
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  <span className="font-mono text-xs mr-2">{formatTime(chapter.startTime)}</span>
                  {chapter.title}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Segment playlist for takehome jobs */}
      {job.segments && job.segments.length > 0 && !forceStream && job.job_kind !== "stream" && (
        <div className="mt-6">
          <button
            onClick={() => setShowChapters(!showChapters)}
            className="w-full flex items-center justify-between py-3 text-xs text-muted-foreground hover:text-foreground transition-colors border-t border-border/50"
          >
            <span className="flex items-center gap-2">
              <List className="w-3.5 h-3.5" />
              {showChapters ? "Hide sections" : `Sections (${job.segments.filter(s => s.status === "ready").length} ready)`}
            </span>
            {job.status === "processing" && (
              <span className="text-[#D97757]">
                {job.current_section + 1} / {job.total_sections} generating
              </span>
            )}
          </button>

          {showChapters && (
            <div className="max-h-64 overflow-y-auto space-y-1 border border-border/50 rounded-lg p-2 mt-2">
              {job.segments
                .sort((a, b) => a.index - b.index)
                .map((seg) => {
                  const isCurrent = audioUrl?.includes(seg.path);
                  const isReady = seg.status === "ready";
                  return (
                    <button
                      key={seg.index}
                      onClick={() => {
                        if (isReady) {
                          setSegmentIndex(seg.index);
                          setAudioUrl(`/api/storage/${seg.path}`);
                          setTimeout(() => audioRef.current?.play().catch(() => {}), 100);
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
                        {String(seg.index + 1).padStart(2, "0")}
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

      {/* Download button */}
      {job.status === "ready" && job.audio_url && (
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
