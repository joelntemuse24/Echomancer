"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, SkipBack, SkipForward, Download, Volume2, ArrowLeft, Loader2 } from "lucide-react";
import { useState, useEffect, useRef, use } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/supabase/types";

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(75);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();

    async function fetchJob() {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("id", id)
        .single();

      if (!error && data) {
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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
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
  }, [audioUrl]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume / 100;
    }
  }, [volume]);

  const togglePlayback = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (value: number[]) => {
    const seekTo = value[0] ?? 0;
    if (audioRef.current) {
      audioRef.current.currentTime = seekTo;
      setCurrentTime(seekTo);
    }
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
    if (audioUrl) {
      window.open(audioUrl, "_blank");
    }
  };

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // Generate waveform visualization
  const generateWaveform = () => {
    const bars = 120;
    const waveform = [];
    for (let i = 0; i < bars; i++) {
      const height = Math.random() * 60 + 20;
      const progress = (i / bars) * 100;
      const isPast = duration > 0 && progress <= (currentTime / duration) * 100;
      waveform.push(
        <div
          key={i}
          className={`w-1 rounded-full transition-all ${isPast ? "bg-primary" : "bg-muted"}`}
          style={{ height: `${height}%` }}
        />
      );
    }
    return waveform;
  };

  if (!job) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" />}

      <Button variant="ghost" onClick={() => router.push("/dashboard/queue")} className="gap-2">
        <ArrowLeft className="w-4 h-4" />
        Back to Queue
      </Button>

      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Now Playing</h1>
        <p className="text-muted-foreground">{job.book_title}</p>
      </div>

      {/* Player Card */}
      <Card className="bg-card border-border overflow-hidden">
        <CardHeader className="border-b border-border">
          <CardTitle>Audio Player</CardTitle>
        </CardHeader>
        <CardContent className="p-8 space-y-8">
          {/* Waveform Visualization */}
          <div className="relative">
            <div className="h-32 flex items-center justify-between gap-1 bg-muted/30 rounded-lg p-4">
              {generateWaveform()}
            </div>
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary transition-all"
              style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>

          {/* Timeline */}
          <div className="space-y-3">
            <Slider
              value={[currentTime]}
              onValueChange={handleSeek}
              min={0}
              max={duration || 1}
              step={1}
              className="w-full"
            />
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Playback Controls */}
          <div className="flex items-center justify-center gap-4">
            <Button size="icon" variant="outline" onClick={handleSkipBack} className="w-12 h-12">
              <SkipBack className="w-5 h-5" />
            </Button>
            <Button
              size="icon"
              onClick={togglePlayback}
              className="w-16 h-16 bg-primary hover:bg-primary/90 text-primary-foreground glow-purple"
              disabled={!audioUrl}
            >
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
            </Button>
            <Button size="icon" variant="outline" onClick={handleSkipForward} className="w-12 h-12">
              <SkipForward className="w-5 h-5" />
            </Button>
          </div>

          {/* Volume Control */}
          <div className="flex items-center gap-4">
            <Volume2 className="w-5 h-5 text-muted-foreground shrink-0" />
            <Slider
              value={[volume]}
              onValueChange={(value) => setVolume(value[0] ?? 100)}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
            <span className="text-sm text-muted-foreground w-12 text-right">{volume}%</span>
          </div>
        </CardContent>
      </Card>

      {/* Download Options */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Download Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button variant="outline" className="w-full gap-2 justify-start" onClick={handleDownload} disabled={!audioUrl}>
            <Download className="w-4 h-4" />
            <div className="text-left flex-1">
              <div>Download Audio</div>
              <div className="text-xs text-muted-foreground">WAV format</div>
            </div>
          </Button>
          <div className="text-xs text-muted-foreground bg-muted/30 p-4 rounded-lg">
            <p>
              <strong>Note:</strong> Downloaded audiobooks are for personal use only.
              Please respect copyright laws and the original content creator&apos;s rights.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Metadata */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Audiobook Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Duration:</span>
              <div>{formatTime(duration)}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Voice:</span>
              <div>{job.voice_name}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Status:</span>
              <div className="capitalize">{job.status}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Generated:</span>
              <div>{new Date(job.created_at).toLocaleDateString()}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
