"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import React, { useState, useEffect, useRef, Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

function debounce<T extends (...args: number[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export default function VoiceClippingPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>}>
      <VoiceClippingContent />
    </Suspense>
  );
}

function VoiceClippingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const checkTimeRef = useRef<(() => void) | null>(null);

  const pdfPath = searchParams.get("pdfPath") || "";
  const pdfName = searchParams.get("pdfName") || "";
  const videoTitle = searchParams.get("videoTitle") || "";
  const voicePath = searchParams.get("voicePath") || "";
  const isUpload = searchParams.get("isUpload") === "true";

  const rawStart = Number(searchParams.get("startTime"));
  const rawEnd = Number(searchParams.get("endTime"));
  const [startTime, setStartTime] = useState(Number.isFinite(rawStart) && rawStart >= 0 ? rawStart : 0);
  const [endTime, setEndTime] = useState(Number.isFinite(rawEnd) && rawEnd >= 0 ? rawEnd : 30);
  const [currentTime, setCurrentTime] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [downloadedVoicePath, setDownloadedVoicePath] = useState(voicePath);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const previewRef = useRef<HTMLAudioElement>(null);

  const maxClipDuration = 30;
  const sliderMax = audioDuration > 0 ? Math.ceil(audioDuration) : 300;

  // Sync clip timestamps to URL so they survive page refresh
  const syncToUrl = useCallback(
    debounce((start: number, end: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("startTime", String(start));
      params.set("endTime", String(end));
      router.replace(`/dashboard/voice/clip?${params.toString()}`, { scroll: false });
    }, 300),
    [searchParams, router]
  );

  useEffect(() => {
    if (voicePath) {
      setAudioUrl(`/api/storage/${voicePath}`);
    }
  }, [voicePath]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onDuration = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setAudioDuration(audio.duration);
        if (endTime === 30 && audio.duration < 30) {
          const adjusted = Math.floor(audio.duration);
          setEndTime(adjusted);
          syncToUrl(startTime, adjusted);
        }
      }
    };
    const onEnded = () => setIsPlaying(false);

    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleSliderChange = (values: number[]) => {
    const newStart = values[0] ?? 0;
    let newEnd = values[1] ?? 30;
    if (newEnd - newStart > maxClipDuration) {
      newEnd = newStart + maxClipDuration;
    }
    setStartTime(newStart);
    setEndTime(newEnd);
    syncToUrl(newStart, newEnd);

    if (audioRef.current) {
      audioRef.current.currentTime = newStart;
    }
  };

  const handlePreview = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) {
      toast.error("No audio loaded");
      return;
    }
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      if (checkTimeRef.current) {
        audio.removeEventListener("timeupdate", checkTimeRef.current);
        checkTimeRef.current = null;
      }
      return;
    }
    audio.currentTime = startTime;
    audio.play().catch(() => {});
    setIsPlaying(true);

    const checkTime = () => {
      if (audio.currentTime >= endTime) {
        audio.pause();
        setIsPlaying(false);
        audio.removeEventListener("timeupdate", checkTime);
        checkTimeRef.current = null;
      }
    };
    checkTimeRef.current = checkTime;
    audio.addEventListener("timeupdate", checkTime);
  }, [audioUrl, isPlaying, startTime, endTime]);

  const handleSkipBack = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const newTime = Math.max(0, audio.currentTime - seconds);
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  }, []);

  const handleSkipForward = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const newTime = Math.min(audioDuration, audio.currentTime + seconds);
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  }, [audioDuration]);

  // Track current time for keyboard shortcuts
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    audio.addEventListener("timeupdate", onTimeUpdate);
    return () => audio.removeEventListener("timeupdate", onTimeUpdate);
  }, [audioUrl]);

  const handleVoicePreview = useCallback(async () => {
    const finalVoicePath = downloadedVoicePath || voicePath;
    if (!finalVoicePath) {
      toast.error("No voice sample selected");
      return;
    }
    setIsGeneratingPreview(true);
    try {
      const res = await fetch("/api/voice/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceStoragePath: finalVoicePath,
          startTime,
          endTime,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preview failed");
      if (data.previewUrl) {
        setPreviewUrl(data.previewUrl);
        setTimeout(() => {
          previewRef.current?.play().catch(() => {});
          setIsPreviewPlaying(true);
        }, 300);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Voice preview failed");
    } finally {
      setIsGeneratingPreview(false);
    }
  }, [downloadedVoicePath, voicePath, startTime, endTime]);

  const handleUseClip = useCallback(async () => {
    const clipDuration = endTime - startTime;
    if (clipDuration < 3) {
      toast.error("Clip must be at least 3 seconds");
      return;
    }
    if (clipDuration > maxClipDuration) {
      toast.error(`Max ${maxClipDuration} seconds`);
      return;
    }
    const finalVoicePath = downloadedVoicePath || voicePath;
    if (!finalVoicePath) {
      toast.error("Download audio first");
      return;
    }
    setIsSubmitting(true);
    try {
      // Save voice to favorites for reuse
      fetch("/api/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: videoTitle || "Custom Voice",
          storagePath: finalVoicePath,
          source: "upload",
        }),
      }).catch(() => {}); // Fire and forget — don't block job creation

      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfStoragePath: pdfPath,
          bookTitle: pdfName,
          voiceStoragePath: finalVoicePath,
          voiceName: videoTitle,
          startTime,
          endTime,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create job");
      if (data.duplicate) {
        toast.success("This audiobook already exists! Opening it now.");
        router.push(`/dashboard/player/${data.jobId}`);
      } else {
        toast.success("Added to queue");
        router.push("/dashboard/queue");
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to create job");
    } finally {
      setIsSubmitting(false);
    }
  }, [endTime, startTime, maxClipDuration, downloadedVoicePath, voicePath, pdfPath, pdfName, videoTitle, router]);

  const clipDuration = endTime - startTime;
  const clipTooLong = clipDuration > maxClipDuration;
  const clipTooShort = clipDuration < 3;

  // Generate waveform bars for visualization
  const generateWaveform = () => {
    return Array.from({ length: 40 }).map((_, i) => {
      const barPosition = i / 40;
      const startPosition = startTime / sliderMax;
      const endPosition = endTime / sliderMax;
      const isInRange = barPosition >= startPosition && barPosition <= endPosition;

      return (
        <div
          key={i}
          className={`w-1 rounded-full transition-all duration-200 ${
            isInRange ? "bg-primary" : "bg-accent"
          }`}
          style={{
            height: `${20 + Math.sin(i * 0.5) * 15 + Math.cos(i * 0.3) * 10}%`,
            opacity: isInRange ? 1 : 0.5
          }}
        />
      );
    });
  };

  // Keyboard shortcuts - placed after all handler functions are defined
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not typing in an input
      if (e.target instanceof HTMLInputElement) return;

      // Calculate these inside the handler to avoid dependency issues
      const duration = endTime - startTime;
      const tooLong = duration > maxClipDuration;
      const tooShort = duration < 3;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          handlePreview();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) {
            handleSkipBack(5);
          } else {
            handleSkipBack(1);
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) {
            handleSkipForward(5);
          } else {
            handleSkipForward(1);
          }
          break;
        case "Enter":
          if (!isSubmitting && !tooLong && !tooShort && (downloadedVoicePath || voicePath)) {
            handleUseClip();
          }
          break;
        case "Escape":
          router.back();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, downloadedVoicePath, voicePath, startTime, endTime, isPlaying, maxClipDuration, handlePreview, handleSkipBack, handleSkipForward, handleUseClip, router]);

  return (
    <div className="max-w-2xl mx-auto pt-8" ref={containerRef}>
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" />}

      {/* Header */}
      <div className="text-center space-y-2 mb-8">
        <h1 className="text-5xl md:text-6xl tracking-tight text-foreground font-serif" style={{ fontWeight: 300 }}>Clip voice</h1>
      </div>

      {/* PDF pill */}
      <div className="flex justify-center mb-8">
        <button
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent border border-border/50 text-xs text-muted-foreground hover:border-border transition-colors"
          onClick={() => router.back()}
        >
          <ArrowLeft className="w-3 h-3" />
          <span className="max-w-[180px] truncate">{pdfName}</span>
        </button>
      </div>

      {/* Audio info */}
      {isUpload && (
        <div className="text-center mb-6">
          <p className="text-sm text-muted-foreground">{videoTitle}</p>
          {audioDuration > 0 && (
            <p className="text-xs text-muted-foreground/50 mt-1">{formatTime(audioDuration)}</p>
          )}
        </div>
      )}

      {/* Waveform visualization */}
      {audioUrl && (
        <div className="h-16 flex items-center justify-between gap-1 mb-6 px-2">
          {generateWaveform()}
        </div>
      )}

      {/* Manual time inputs - MM:SS format */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1">
          <label className="text-xs text-muted-foreground block mb-1">Start (MM:SS)</label>
          <input
            type="text"
            placeholder="0:00"
            value={formatTime(startTime)}
            onChange={(e) => {
              const val = e.target.value;
              const match = val.match(/^(?:(\d+):)?(\d+)$/);
              if (match) {
                const mins = parseInt(match[1] || '0') || 0;
                const secs = parseInt(match[2] || '0') || 0;
                const totalSeconds = mins * 60 + secs;
                const maxStart = Math.max(0, sliderMax - 3);
                const newStart = Math.min(Math.max(0, totalSeconds), maxStart);
                setStartTime(newStart);
                syncToUrl(newStart, endTime);
                if (audioRef.current) {
                  audioRef.current.currentTime = newStart;
                }
              }
            }}
            className="w-full h-10 px-3 bg-background border border-border rounded-sm text-sm focus:border-foreground/30 focus:outline-none font-mono"
          />
          <span className="text-xs text-muted-foreground">{formatTime(startTime)} ({startTime}s)</span>
        </div>
        <div className="flex-1">
          <label className="text-xs text-muted-foreground block mb-1">End (MM:SS)</label>
          <input
            type="text"
            placeholder={formatTime(Math.min(30, sliderMax))}
            value={formatTime(endTime)}
            onChange={(e) => {
              const val = e.target.value;
              const match = val.match(/^(?:(\d+):)?(\d+)$/);
              if (match) {
                const mins = parseInt(match[1] || '0') || 0;
                const secs = parseInt(match[2] || '0') || 0;
                const totalSeconds = mins * 60 + secs;
                const newEnd = Math.min(Math.max(startTime + 3, totalSeconds), sliderMax);
                setEndTime(newEnd);
                syncToUrl(startTime, newEnd);
              }
            }}
            className="w-full h-10 px-3 bg-background border border-border rounded-sm text-sm focus:border-foreground/30 focus:outline-none font-mono"
          />
          <span className="text-xs text-muted-foreground">{formatTime(endTime)} ({endTime}s)</span>
        </div>
      </div>

      {/* Slider */}
      <div className="mb-6">
        <Slider
          value={[startTime, endTime]}
          onValueChange={handleSliderChange}
          min={0}
          max={sliderMax}
          step={1}
          className="w-full cursor-pointer"
        />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground/50 mt-2 font-mono">
          <span>0:00</span>
          <span>{formatTime(sliderMax)}</span>
        </div>
      </div>

      {/* Duration info */}
      <div className={`p-4 rounded-xl border mb-6 ${
        clipTooLong ? "border-destructive/30 bg-destructive/5" :
        clipTooShort ? "border-yellow-500/30 bg-yellow-500/5" :
        "border-border/50 bg-accent/20"
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Duration</span>
            {clipTooLong && <span className="text-[10px] text-destructive">Too long</span>}
            {clipTooShort && <span className="text-[10px] text-yellow-500">Too short</span>}
            {!clipTooLong && !clipTooShort && clipDuration >= 30 && (
              <span className="text-[10px] text-emerald-500/80">Perfect</span>
            )}
          </div>
          <span className={`text-sm font-medium font-mono ${
            clipTooLong ? "text-destructive" : clipTooShort ? "text-yellow-500" : "text-foreground"
          }`}>
            {formatTime(clipDuration)}
          </span>
        </div>
        {!clipTooLong && !clipTooShort && clipDuration < 30 && (
          <p className="text-[10px] text-muted-foreground/70 mt-2">15-30s recommended for best quality</p>
        )}
      </div>

      {/* Preview button */}
      <Button
        variant="outline"
        className="w-full mb-4 border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent rounded-full h-11"
        onClick={handlePreview}
        disabled={!audioUrl}
      >
        {isPlaying ? <Pause className="w-4 h-4 mr-2" /> : <Play className="w-4 h-4 mr-2" />}
        {isPlaying ? "Stop" : "Preview clip"}
      </Button>

      {/* Voice preview — hear how the cloned voice sounds */}
      {previewUrl && <audio ref={previewRef} src={previewUrl} preload="auto" onEnded={() => setIsPreviewPlaying(false)} />}
      <Button
        variant="outline"
        className="w-full mb-4 border-primary/30 text-primary hover:bg-primary/10 rounded-full h-11"
        onClick={isPreviewPlaying ? () => { previewRef.current?.pause(); setIsPreviewPlaying(false); } : handleVoicePreview}
        disabled={isGeneratingPreview || (!downloadedVoicePath && !voicePath)}
      >
        {isGeneratingPreview ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : isPreviewPlaying ? (
          <Pause className="w-4 h-4 mr-2" />
        ) : (
          <Play className="w-4 h-4 mr-2" />
        )}
        {isGeneratingPreview ? "Generating preview..." : isPreviewPlaying ? "Stop preview" : "Test this voice"}
      </Button>

      {/* Keyboard shortcuts hint */}
      <div className="flex items-center justify-center gap-4 text-[10px] text-muted-foreground/70 mb-6">
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-accent border border-border/50">Space</kbd> to play
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-accent border border-border/50">←</kbd>
          <kbd className="px-1.5 py-0.5 rounded bg-accent border border-border/50">→</kbd> to seek
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 rounded bg-accent border border-border/50">Enter</kbd> to create
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <Button
          variant="outline"
          onClick={() => router.back()}
          className="flex-1 border-border/50 text-muted-foreground hover:text-foreground rounded-full h-11"
        >
          Back
        </Button>
        <Button
          onClick={handleUseClip}
          disabled={isSubmitting || clipTooLong || clipTooShort || (!downloadedVoicePath && !voicePath)}
          className="flex-[2] rounded-full h-11 disabled:opacity-50 font-medium"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <><CheckCircle2 className="w-4 h-4 mr-2" />Create audiobook</>
          )}
        </Button>
      </div>
    </div>
  );
}
