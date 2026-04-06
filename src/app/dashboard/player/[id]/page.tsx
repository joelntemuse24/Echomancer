"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, SkipBack, SkipForward, Download, Volume2, ArrowLeft, Loader2 } from "lucide-react";
import React, { useState, useEffect, useRef, useMemo, use } from "react";
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
  const [isDragging, setIsDragging] = useState(false);

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

    const onTimeUpdate = () => {
      if (!isDragging) {
        setCurrentTime(audio.currentTime);
      }
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
    setCurrentTime(seekTo);
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

  // Generate waveform visualization (pure component)
  const waveformHeights = React.useMemo(() => {
    const bars = 120;
    const heights = [];
    for (let i = 0; i < bars; i++) {
      // Deterministic pseudo-random heights using sine waves
      const height = 40 + Math.sin(i * 0.5) * 20 + Math.cos(i * 0.2) * 10;
      heights.push(height);
    }
    return heights;
  }, []);

  const generateWaveform = () => {
    const bars = 120;
    return waveformHeights.map((height, i) => {
      const progress = (i / bars) * 100;
      const isPast = duration > 0 && progress <= (currentTime / duration) * 100;
      return (
        <div
          key={i}
          className={`w-1 rounded-full transition-all ${isPast ? "bg-[#D97757]" : "bg-[#333]"}`}
          style={{ height: `${height}%` }}
        />
      );
    });
  };

  if (!job) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[#D97757]" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" />}

      <Button variant="ghost" onClick={() => router.push("/dashboard/queue")} className="gap-2 text-[#a39b8f] hover:text-[#faf9f7] hover:bg-[#242424]">
        <ArrowLeft className="w-4 h-4" />
        Back to Queue
      </Button>

      <div className="space-y-2">
        <h1 className="text-3xl font-bold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">Now Playing</h1>
        <p className="text-[#a39b8f]">{job.book_title}</p>
      </div>

      {/* Player Card */}
      <Card className="bg-[#1a1a1a] border-[#333] overflow-hidden">
        <CardHeader className="border-b border-[#333]">
          <CardTitle>Audio Player</CardTitle>
        </CardHeader>
        <CardContent className="p-8 space-y-8">
          {/* Waveform Visualization */}
          <div className="relative">
            <div className="h-32 flex items-center justify-between gap-1 bg-[#242424]/50 rounded-lg p-4">
              {generateWaveform()}
            </div>
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[#D97757] transition-all"
              style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>

          {/* Timeline */}
          <div className="space-y-3">
            <Slider
              value={[currentTime]}
              onValueChange={(val) => {
                if (!isDragging) setIsDragging(true);
                handleSeek(val);
              }}
              onValueCommit={handleSeekCommit}
              min={0}
              max={duration || 1}
              step={0.1}
              className="w-full"
            />
            <div className="flex items-center justify-between text-sm text-[#a39b8f]">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Playback Controls */}
          <div className="flex items-center justify-center gap-4">
            <Button size="icon" variant="outline" onClick={handleSkipBack} className="w-12 h-12 border-[#333] text-[#faf9f7] hover:bg-[#242424]">
              <SkipBack className="w-5 h-5" />
            </Button>
            <Button
              size="icon"
              onClick={togglePlayback}
              className="w-16 h-16 bg-[#D97757] hover:bg-[#E8957A] text-[#0d0d0d] glow-copper"
              disabled={!audioUrl}
            >
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
            </Button>
            <Button size="icon" variant="outline" onClick={handleSkipForward} className="w-12 h-12 border-[#333] text-[#faf9f7] hover:bg-[#242424]">
              <SkipForward className="w-5 h-5" />
            </Button>
          </div>

          {/* Volume Control */}
          <div className="flex items-center gap-4">
            <Volume2 className="w-5 h-5 text-[#a39b8f] shrink-0" />
            <Slider
              value={[volume]}
              onValueChange={(value) => setVolume(value[0] ?? 100)}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
            <span className="text-sm text-[#a39b8f] w-12 text-right">{volume}%</span>
          </div>
        </CardContent>
      </Card>

      {/* Download Options */}
      <Card className="bg-[#1a1a1a] border-[#333]">
        <CardHeader>
          <CardTitle>Download Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button variant="outline" className="w-full gap-2 justify-start border-[#333] text-[#faf9f7] hover:bg-[#242424]" onClick={handleDownload} disabled={!audioUrl}>
            <Download className="w-4 h-4" />
            <div className="text-left flex-1">
              <div>Download Audio</div>
              <div className="text-xs text-[#a39b8f]">MP3 format</div>
            </div>
          </Button>
          <div className="text-xs text-[#a39b8f] bg-[#242424] p-4 rounded-lg border border-[#333]">
            <p>
              <strong className="text-[#faf9f7]">Note:</strong> Downloaded audiobooks are for personal use only.
              Please respect copyright laws and the original content creator&apos;s rights.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Metadata */}
      <Card className="bg-[#1a1a1a] border-[#333]">
        <CardHeader>
          <CardTitle>Audiobook Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-[#a39b8f]">Duration:</span>
              <div className="text-[#faf9f7]">{formatTime(duration)}</div>
            </div>
            <div>
              <span className="text-[#a39b8f]">Voice:</span>
              <div className="text-[#faf9f7]">{job.voice_name}</div>
            </div>
            <div>
              <span className="text-[#a39b8f]">Status:</span>
              <div className="capitalize text-[#faf9f7]">{job.status}</div>
            </div>
            <div>
              <span className="text-[#a39b8f]">Generated:</span>
              <div className="text-[#faf9f7]">{new Date(job.created_at).toLocaleDateString()}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
