"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { 
  Play, Pause, SkipBack, SkipForward, Download, Volume2, 
  ArrowLeft, Loader2, Gauge, Activity, AudioWaveform, Zap, List
} from "lucide-react";
import React, { useState, useEffect, useRef, use } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import type { Job } from "@/lib/supabase/types";
import { userFriendlyError } from "@/lib/errors-ui";

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement>(null);
  const processorInitialized = useRef(false);

  const [job, setJob] = useState<Job | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(75);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const realtimeReceived = useRef(false);

  // Audio processor hook
  const { 
    initialize, resume, setSpeed, setPitch, setDepth, setDynamics, setVolume,
    isReady: processorReady, controls 
  } = useAudioProcessor();

  // Fetch job data
  useEffect(() => {
    const supabase = createClient();

    async function fetchJob() {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("id", id)
        .single();

      // Skip stale fetch if realtime already delivered fresher data
      if (!error && data && !realtimeReceived.current) {
        setJob(data as Job);
        if (data.audio_storage_path) {
          const { data: urlData } = supabase.storage
            .from("audiobooks")
            .getPublicUrl(data.audio_storage_path);
          if (urlData?.publicUrl) {
            setAudioUrl(urlData.publicUrl);
          }
        }
      }
    }

    fetchJob();
  }, [id]);

  // Realtime subscription (separate from fetch to avoid re-subscribing on audioUrl change)
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`job-${id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "jobs", filter: `id=eq.${id}` },
        (payload) => {
          realtimeReceived.current = true;
          const updated = payload.new as Job;
          setJob(updated);
          if (updated.audio_storage_path) {
            const { data: urlData } = supabase.storage
              .from("audiobooks")
              .getPublicUrl(updated.audio_storage_path);
            if (urlData?.publicUrl) {
              setAudioUrl(urlData.publicUrl);
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id]);

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
      if (!isDragging) setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl, isDragging]);

  const togglePlayback = async () => {
    if (!audioRef.current) return;
    
    // Resume audio context if suspended (browser policy)
    await resume();
    
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeekCommit = (value: number[]) => {
    const seekTo = value[0] ?? 0;
    if (audioRef.current) {
      audioRef.current.currentTime = seekTo;
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
    if (!audioUrl || !job) return;
    const safeTitle = job.book_title.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "audiobook";
    const filename = `${safeTitle}.mp3`;
    const downloadUrl = `${audioUrl}?download=${encodeURIComponent(filename)}`;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename;
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

  const handlePitchChange = (value: number[]) => {
    const pitch = value[0] ?? 0;
    setPitch(pitch);
  };

  const handleDepthChange = (value: number[]) => {
    const depth = value[0] ?? 0;
    setDepth(depth);
  };

  const handleDynamicsChange = (value: number[]) => {
    const dynamics = value[0] ?? 50;
    setDynamics(dynamics);
  };

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

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
          crossOrigin="anonymous"
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
      <div className="text-center space-y-2 mb-8">
        <h1 className="text-4xl md:text-5xl tracking-tight text-foreground truncate px-4 font-serif" style={{ fontWeight: 300 }}>{job.book_title}</h1>
        <p className="text-sm text-muted-foreground font-serif">Voice: {job.voice_name}</p>
      </div>

      {/* Album art / Visualizer */}
      <div className="relative mb-8">
        <div className="aspect-square max-w-[280px] mx-auto rounded-2xl bg-gradient-to-br from-accent/50 to-background border border-border/50 flex items-center justify-center overflow-hidden">
          {/* Animated waveform background */}
          <div className="absolute inset-0 opacity-20">
            {Array.from({ length: 20 }).map((_, i) => (
              <div
                key={i}
                className="absolute w-full h-px bg-primary"
                style={{
                  top: `${50 + Math.sin(i * 0.8) * 30}%`,
                  opacity: isPlaying ? 0.3 + Math.random() * 0.4 : 0.1,
                  transform: `scaleX(${isPlaying ? 0.5 + Math.random() * 0.5 : 0.3})`,
                  transition: "all 0.2s ease",
                }}
              />
            ))}
          </div>

          {/* Center play indicator */}
          <button
            onClick={togglePlayback}
            className="relative z-10 w-20 h-20 rounded-full bg-primary hover:bg-primary/90 flex items-center justify-center transition-all hover:scale-105 text-primary-foreground shadow-lg"
          >
            {isPlaying ? (
              <Pause className="w-8 h-8" />
            ) : (
              <Play className="w-8 h-8 ml-1" />
            )}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-2 mb-8">
        <Slider
          value={[currentTime]}
          onValueChange={(val) => {
            setIsDragging(true);
            setCurrentTime(val[0] ?? 0);
          }}
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

      {/* Main controls */}
      <div className="flex items-center justify-center gap-4 mb-8">
        <Button
          size="icon"
          variant="ghost"
          onClick={handleSkipBack}
          className="w-12 h-12 text-muted-foreground hover:text-foreground hover:bg-accent rounded-full"
        >
          <SkipBack className="w-5 h-5" />
        </Button>

        <Button
          size="icon"
          onClick={togglePlayback}
          className="w-16 h-16 bg-primary hover:bg-primary/90 text-primary-foreground rounded-full shadow-md transition-transform hover:scale-105"
        >
          {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
        </Button>

        <Button
          size="icon"
          variant="ghost"
          onClick={handleSkipForward}
          className="w-12 h-12 text-muted-foreground hover:text-foreground hover:bg-accent rounded-full"
        >
          <SkipForward className="w-5 h-5" />
        </Button>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-4 mb-6">
        <Volume2 className="w-4 h-4 text-muted-foreground shrink-0" />
        <Slider
          value={[volume]}
          onValueChange={(value) => setVolumeState(value[0] ?? 100)}
          min={0}
          max={100}
          step={1}
          className="flex-1 cursor-pointer"
        />
        <span className="text-xs text-muted-foreground w-10 text-right font-mono">{volume}%</span>
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

      {/* Toggle advanced controls */}
      <button
        onClick={() => setShowControls(!showControls)}
        className="w-full flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground hover:text-foreground transition-colors border-t border-border/50"
      >
        <Activity className="w-3.5 h-3.5" />
        {showControls ? "Hide audio controls" : "Audio controls"}
      </button>

      {/* Advanced Audio Controls */}
      {showControls && (
        <div className="mt-6 space-y-6 p-6 rounded-2xl border border-border/50 bg-accent/30">
          {/* Speed Control */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Gauge className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Speed</span>
              </div>
              <span className="text-xs text-primary font-medium">{controls.speed.toFixed(2)}x</span>
            </div>
            <Slider
              value={[controls.speed]}
              onValueChange={handleSpeedChange}
              min={0.5}
              max={2}
              step={0.05}
              className="cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground/70">
              <span>0.5x</span>
              <span>1x</span>
              <span>2x</span>
            </div>
          </div>

          {/* Pitch Control */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AudioWaveform className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Voice character</span>
              </div>
              <span className="text-xs text-primary font-medium">{controls.pitch > 0 ? `+${controls.pitch}` : controls.pitch}</span>
            </div>
            <Slider
              value={[controls.pitch]}
              onValueChange={handlePitchChange}
              min={-12}
              max={12}
              step={1}
              className="cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground/70">
              <span>Deeper</span>
              <span>Normal</span>
              <span>Higher</span>
            </div>
          </div>

          {/* Depth (Bass) Control */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Depth</span>
              </div>
              <span className="text-xs text-primary font-medium">{controls.depth > 0 ? `+${controls.depth}` : controls.depth}</span>
            </div>
            <Slider
              value={[controls.depth]}
              onValueChange={handleDepthChange}
              min={-100}
              max={100}
              step={5}
              className="cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground/70">
              <span>Thin</span>
              <span>Neutral</span>
              <span>Rich</span>
            </div>
          </div>

          {/* Dynamics Control */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Dynamics</span>
              </div>
              <span className="text-xs text-primary font-medium">{controls.dynamics}%</span>
            </div>
            <Slider
              value={[controls.dynamics]}
              onValueChange={handleDynamicsChange}
              min={0}
              max={100}
              step={5}
              className="cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground/70">
              <span>Natural</span>
              <span>Compressed</span>
            </div>
          </div>
        </div>
      )}

      {/* Download button */}
      <Button
        variant="outline"
        onClick={handleDownload}
        disabled={!audioUrl}
        className="w-full mt-8 h-12 rounded-full border-border/50 hover:bg-accent hover:text-foreground transition-all flex items-center justify-center gap-2"
      >
        <Download className="w-4 h-4" />
        Download MP3
      </Button>

      {/* Status section (processing only) */}
      {job.status !== "ready" && (
        <div className="mt-8 p-4 rounded-xl border border-border/50 bg-accent/20">
          <div className="flex items-center gap-3">
            {job.status === "failed" ? (
              <div className="w-8 h-8 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <Loader2 className="w-4 h-4 text-destructive" />
              </div>
            ) : (
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Loader2 className="w-4 h-4 text-primary animate-spin" />
              </div>
            )}
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground capitalize">
                {job.status === "failed" ? "Generation failed" : `${job.status}...`}
              </p>
              {job.error ? (
                <p className="text-xs text-destructive mt-1">{userFriendlyError(job.error)}</p>
              ) : job.progress !== undefined ? (
                <div className="mt-2">
                  <div className="h-1.5 w-full bg-accent rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 text-right">{job.progress}%</p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
