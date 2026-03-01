"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Play, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

  const pdfPath = searchParams.get("pdfPath") || "";
  const pdfName = searchParams.get("pdfName") || "";
  const videoId = searchParams.get("videoId") || "";
  const videoTitle = searchParams.get("videoTitle") || "";
  const voicePath = searchParams.get("voicePath") || "";
  const isUpload = searchParams.get("isUpload") === "true";

  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(60);
  const [startMinutes, setStartMinutes] = useState("00");
  const [startSeconds, setStartSeconds] = useState("00");
  const [endMinutes, setEndMinutes] = useState("01");
  const [endSeconds, setEndSeconds] = useState("00");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const maxDuration = 300;

  useEffect(() => {
    setStartMinutes(Math.floor(startTime / 60).toString().padStart(2, "0"));
    setStartSeconds((startTime % 60).toString().padStart(2, "0"));
  }, [startTime]);

  useEffect(() => {
    setEndMinutes(Math.floor(endTime / 60).toString().padStart(2, "0"));
    setEndSeconds((endTime % 60).toString().padStart(2, "0"));
  }, [endTime]);

  const handleStartTimeInput = (minutes: string, seconds: string) => {
    const min = parseInt(minutes) || 0;
    const sec = parseInt(seconds) || 0;
    const totalSeconds = Math.min(min * 60 + sec, maxDuration);
    setStartTime(totalSeconds);
    setStartMinutes(min.toString().padStart(2, "0"));
    setStartSeconds(sec.toString().padStart(2, "0"));
  };

  const handleEndTimeInput = (minutes: string, seconds: string) => {
    const min = parseInt(minutes) || 0;
    const sec = parseInt(seconds) || 0;
    const totalSeconds = Math.min(min * 60 + sec, maxDuration);
    setEndTime(totalSeconds);
    setEndMinutes(min.toString().padStart(2, "0"));
    setEndSeconds(sec.toString().padStart(2, "0"));
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleSliderChange = (values: number[]) => {
    setStartTime(values[0] ?? 0);
    setEndTime(values[1] ?? 60);
  };

  const handleUseClip = async () => {
    if (!agreedToTerms) return;

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfStoragePath: pdfPath,
          bookTitle: pdfName,
          videoId: isUpload ? undefined : videoId,
          voiceStoragePath: voicePath || undefined,
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

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <Button variant="ghost" onClick={() => router.back()} className="gap-2">
        <ArrowLeft className="w-4 h-4" />
        Back to Search
      </Button>

      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Clip Voice Sample</h1>
        <p className="text-muted-foreground">Select a portion of the video to use as your voice sample</p>
      </div>

      {/* YouTube Embed or Audio Player */}
      <Card className="bg-card border-border overflow-hidden">
        <CardContent className="p-0">
          <div className="aspect-video bg-muted flex items-center justify-center">
            {isUpload ? (
              <div className="w-full h-full flex flex-col items-center justify-center p-8 space-y-4">
                <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                  <Play className="w-10 h-10 text-primary" />
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-lg font-semibold">{videoTitle}</h3>
                  <p className="text-sm text-muted-foreground">Uploaded Audio Sample</p>
                </div>
              </div>
            ) : (
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
            )}
          </div>
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
                  max={maxDuration}
                  step={1}
                  className="w-full"
                  minStepsBetweenThumbs={5}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>0:00</span>
                <span>5:00</span>
              </div>
            </div>

            {/* Time Inputs */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <Label>Start Time</Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input type="number" min="0" max="5" value={startMinutes} onChange={(e) => handleStartTimeInput(e.target.value, startSeconds)} placeholder="MM" className="text-center" />
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
                    <Input type="number" min="0" max="5" value={endMinutes} onChange={(e) => handleEndTimeInput(e.target.value, endSeconds)} placeholder="MM" className="text-center" />
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
            <div className="bg-muted/50 p-4 rounded-lg">
              <div className="flex items-center justify-between">
                <span className="text-sm">Clip Duration:</span>
                <span className="font-semibold">{formatTime(endTime - startTime)}</span>
              </div>
            </div>

            {/* Preview Button */}
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => toast.info(`Preview: ${formatTime(startTime)} - ${formatTime(endTime)} (${formatTime(endTime - startTime)} duration)`)}
            >
              <Play className="w-4 h-4" />
              Preview Clip ({formatTime(endTime - startTime)})
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Terms Agreement */}
      <Card className="bg-card border-border">
        <CardContent className="p-6">
          <div className="flex items-start gap-3">
            <Checkbox
              id="terms"
              checked={agreedToTerms}
              onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
              className="mt-1"
            />
            <div className="space-y-1">
              <label htmlFor="terms" className="text-sm leading-relaxed cursor-pointer">
                I confirm that I have the right to use this voice sample and agree to echomancer&apos;s{" "}
                <a href="#" className="text-primary hover:underline">Terms of Service</a> and{" "}
                <a href="#" className="text-primary hover:underline">Voice Usage Policy</a>.
                I understand that I am responsible for ensuring I have appropriate permissions for voice cloning.
              </label>
            </div>
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
          disabled={!agreedToTerms || isSubmitting}
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
