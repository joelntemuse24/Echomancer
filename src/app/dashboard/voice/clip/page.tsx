"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, ArrowLeft, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

export default function VoiceClippingPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}>
      <VoiceClippingContent />
    </Suspense>
  );
}

function VoiceClippingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const audioRef = useRef<HTMLAudioElement>(null);

  const pdfPath = searchParams.get("pdfPath") || "";
  const pdfName = searchParams.get("pdfName") || "";
  const videoId = searchParams.get("videoId") || "";
  const videoTitle = searchParams.get("videoTitle") || "";
  const voicePath = searchParams.get("voicePath") || "";
  const isUpload = searchParams.get("isUpload") === "true";

  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(30);
  const [startMinutes, setStartMinutes] = useState("00");
  const [startSeconds, setStartSeconds] = useState("00");
  const [endMinutes, setEndMinutes] = useState("00");
  const [endSeconds, setEndSeconds] = useState("30");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Audio preview state
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);

  // YouTube download state — we download the full audio to Supabase so we have a voicePath for job creation
  const [downloadedVoicePath, setDownloadedVoicePath] = useState(voicePath);
  const [isDownloading, setIsDownloading] = useState(false);

  const maxDuration = isUpload ? 300 : 600; // 5min for uploads, 10min for YouTube
  const maxClipDuration = 30; // Zonos max voice sample length

  // Load audio for preview
  useEffect(() => {
    if (isUpload && voicePath) {
      // For uploads, get the public URL from Supabase
      const supabase = createClient();
      const { data } = supabase.storage.from("audiobooks").getPublicUrl(voicePath);
      if (data?.publicUrl) {
        setAudioUrl(data.publicUrl);
      }
    }
    // For YouTube, audio isn't available until downloaded
  }, [isUpload, voicePath]);

  // Update audio duration when loaded
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onDuration = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setAudioDuration(audio.duration);
        // Auto-set end time to min(duration, 30s) if this is the first load
        if (endTime === 30 && audio.duration < 30) {
          setEndTime(Math.floor(audio.duration));
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
  }, [audioUrl, endTime]);

  useEffect(() => {
    setStartMinutes(Math.floor(startTime / 60).toString().padStart(2, "0"));
    setStartSeconds(Math.floor(startTime % 60).toString().padStart(2, "0"));
  }, [startTime]);

  useEffect(() => {
    setEndMinutes(Math.floor(endTime / 60).toString().padStart(2, "0"));
    setEndSeconds(Math.floor(endTime % 60).toString().padStart(2, "0"));
  }, [endTime]);

  const handleStartTimeInput = (minutes: string, seconds: string) => {
    const min = parseInt(minutes) || 0;
    const sec = parseInt(seconds) || 0;
    const totalSeconds = Math.min(min * 60 + sec, maxDuration);
    const newStart = Math.min(totalSeconds, endTime);
    setStartTime(newStart);
  };

  const handleEndTimeInput = (minutes: string, seconds: string) => {
    const min = parseInt(minutes) || 0;
    const sec = parseInt(seconds) || 0;
    const totalSeconds = Math.min(min * 60 + sec, maxDuration);
    const newEnd = Math.max(totalSeconds, startTime);
    setEndTime(newEnd);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleSliderChange = (values: number[]) => {
    const newStart = values[0] ?? 0;
    let newEnd = values[1] ?? 30;
    // Enforce max clip duration of 30s (Zonos limit)
    if (newEnd - newStart > maxClipDuration) {
      newEnd = newStart + maxClipDuration;
    }
    setStartTime(newStart);
    setEndTime(newEnd);
  };

  const handlePreview = () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) {
      toast.error("No audio loaded for preview");
      return;
    }

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }

    audio.currentTime = startTime;
    audio.play();
    setIsPlaying(true);

    // Stop playback at endTime
    const checkTime = () => {
      if (audio.currentTime >= endTime) {
        audio.pause();
        setIsPlaying(false);
        audio.removeEventListener("timeupdate", checkTime);
      }
    };
    audio.addEventListener("timeupdate", checkTime);
  };

  // YouTube: download audio from video for preview + job creation
  const handleDownloadYouTubeAudio = async () => {
    if (!videoId) return;
    setIsDownloading(true);
    setAudioError(null);

    try {
      toast.info("Downloading audio from YouTube...");
      const res = await fetch("/api/youtube/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId,
          startTime: 0, // Download full range, we'll clip via start/end at generation time
          endTime: Math.min(maxDuration, 600),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Download failed");

      setDownloadedVoicePath(data.storagePath);

      // Get public URL for audio preview
      const supabase = createClient();
      const { data: urlData } = supabase.storage.from("audiobooks").getPublicUrl(data.storagePath);
      if (urlData?.publicUrl) {
        setAudioUrl(urlData.publicUrl);
      }

      toast.success("Audio downloaded! You can now preview and clip it.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Download failed";
      setAudioError(message);
      toast.error(message);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleUseClip = async () => {
    const clipDuration = endTime - startTime;
    if (clipDuration < 3) {
      toast.error("Clip must be at least 3 seconds long");
      return;
    }
    if (clipDuration > maxClipDuration) {
      toast.error(`Clip must be ${maxClipDuration} seconds or shorter for best voice cloning`);
      return;
    }

    // For YouTube flow, ensure audio was downloaded first
    const finalVoicePath = downloadedVoicePath || voicePath;
    if (!finalVoicePath) {
      toast.error("Please download the audio first before creating the job");
      return;
    }

    setIsSubmitting(true);
    try {
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

      toast.success("Audiobook added to queue!");
      router.push("/dashboard/queue");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create job";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const clipDuration = endTime - startTime;
  const clipTooLong = clipDuration > maxClipDuration;
  const clipTooShort = clipDuration < 3;
  const sliderMax = audioDuration > 0 ? Math.ceil(audioDuration) : maxDuration;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" />}

      <Button variant="ghost" onClick={() => router.back()} className="gap-2">
        <ArrowLeft className="w-4 h-4" />
        Back
      </Button>

      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Clip Voice Sample</h1>
        <p className="text-muted-foreground">
          Select 15-30 seconds of clean speech to use as your voice sample
        </p>
      </div>

      {/* Video / Audio Preview */}
      <Card className="bg-card border-border overflow-hidden">
        <CardContent className="p-0">
          {!isUpload && videoId ? (
            <>
              <div className="aspect-video bg-muted">
                <iframe
                  width="100%"
                  height="100%"
                  src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1`}
                  title={videoTitle}
                  frameBorder="0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="w-full h-full"
                />
              </div>
              {/* YouTube audio download prompt */}
              {!audioUrl && !isDownloading && (
                <div className="p-6 border-t border-border bg-muted/30">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Download audio for preview &amp; clipping</p>
                      <p className="text-xs text-muted-foreground">
                        We&apos;ll extract the audio from this video so you can clip it precisely
                      </p>
                    </div>
                    <Button onClick={handleDownloadYouTubeAudio} className="gap-2 shrink-0">
                      <Play className="w-4 h-4" />
                      Download Audio
                    </Button>
                  </div>
                  {audioError && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
                      <AlertCircle className="w-4 h-4" />
                      {audioError}
                    </div>
                  )}
                </div>
              )}
              {isDownloading && (
                <div className="p-6 border-t border-border bg-muted/30 flex items-center gap-3">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  <p className="text-sm">Downloading audio from YouTube... This may take a minute.</p>
                </div>
              )}
              {audioUrl && (
                <div className="p-4 border-t border-border bg-green-500/5 flex items-center gap-2 text-sm text-green-500">
                  <CheckCircle2 className="w-4 h-4" />
                  Audio downloaded — use the Preview button below to listen to your clip
                </div>
              )}
            </>
          ) : (
            <div className="p-8 flex flex-col items-center justify-center space-y-4 min-h-[200px]">
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                <Play className="w-10 h-10 text-primary" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-lg font-semibold">{videoTitle}</h3>
                <p className="text-sm text-muted-foreground">Uploaded Audio Sample</p>
                {audioDuration > 0 && (
                  <p className="text-xs text-muted-foreground">Duration: {formatTime(audioDuration)}</p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Clipping Controls */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Voice Clip Selection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Start: {formatTime(startTime)}</span>
                <span className="text-muted-foreground">End: {formatTime(endTime)}</span>
              </div>
              <div className="relative py-4">
                <Slider
                  value={[startTime, endTime]}
                  onValueChange={handleSliderChange}
                  min={0}
                  max={sliderMax}
                  step={1}
                  className="w-full"
                  minStepsBetweenThumbs={3}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>0:00</span>
                <span>{formatTime(sliderMax)}</span>
              </div>
            </div>

            {/* Time Inputs */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <Label>Start Time</Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input type="number" min="0" max="10" value={startMinutes} onChange={(e) => handleStartTimeInput(e.target.value, startSeconds)} placeholder="MM" className="text-center" />
                    <p className="text-xs text-muted-foreground text-center mt-1">Minutes</p>
                  </div>
                  <span className="text-2xl text-muted-foreground">:</span>
                  <div className="flex-1">
                    <Input type="number" min="0" max="59" value={startSeconds} onChange={(e) => handleStartTimeInput(startMinutes, e.target.value)} placeholder="SS" className="text-center" />
                    <p className="text-xs text-muted-foreground text-center mt-1">Seconds</p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <Label>End Time</Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input type="number" min="0" max="10" value={endMinutes} onChange={(e) => handleEndTimeInput(e.target.value, endSeconds)} placeholder="MM" className="text-center" />
                    <p className="text-xs text-muted-foreground text-center mt-1">Minutes</p>
                  </div>
                  <span className="text-2xl text-muted-foreground">:</span>
                  <div className="flex-1">
                    <Input type="number" min="0" max="59" value={endSeconds} onChange={(e) => handleEndTimeInput(endMinutes, e.target.value)} placeholder="SS" className="text-center" />
                    <p className="text-xs text-muted-foreground text-center mt-1">Seconds</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Clip Duration Info */}
            <div className={`p-4 rounded-lg ${clipTooLong ? "bg-destructive/10" : clipTooShort ? "bg-yellow-500/10" : "bg-muted/50"}`}>
              <div className="flex items-center justify-between">
                <span className="text-sm">Clip Duration:</span>
                <span className={`font-semibold ${clipTooLong ? "text-destructive" : clipTooShort ? "text-yellow-500" : ""}`}>
                  {formatTime(clipDuration)}
                </span>
              </div>
              {clipTooLong && (
                <p className="text-xs text-destructive mt-2">
                  Maximum clip duration is {maxClipDuration} seconds for best voice cloning quality
                </p>
              )}
              {clipTooShort && (
                <p className="text-xs text-yellow-500 mt-2">
                  Minimum clip duration is 3 seconds
                </p>
              )}
              {!clipTooLong && !clipTooShort && clipDuration < 15 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Tip: 15-30 seconds gives the best voice cloning results
                </p>
              )}
            </div>

            {/* Preview Button */}
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={handlePreview}
              disabled={!audioUrl}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              {isPlaying ? "Stop Preview" : `Preview Clip (${formatTime(clipDuration)})`}
              {!audioUrl && !isUpload && <span className="text-xs ml-2">(download audio first)</span>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex gap-4">
        <Button variant="outline" onClick={() => router.back()} className="flex-1">
          Cancel
        </Button>
        <Button
          onClick={handleUseClip}
          disabled={isSubmitting || clipTooLong || clipTooShort || (!downloadedVoicePath && !voicePath)}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white glow-green gap-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Creating Job...
            </>
          ) : (
            <>
              <CheckCircle2 className="w-5 h-5" />
              Use This Clip
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
