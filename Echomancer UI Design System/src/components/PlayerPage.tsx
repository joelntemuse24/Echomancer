import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";
import { Play, Pause, SkipBack, SkipForward, Download, Volume2, ArrowLeft } from "lucide-react";
import { useState, useEffect } from "react";

interface PlayerPageProps {
  audiobookId: string;
  bookTitle: string;
  onBack: () => void;
  onDownload: () => void;
}

export function PlayerPage({ audiobookId, bookTitle, onBack, onDownload }: PlayerPageProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(45);
  const [duration, setDuration] = useState(180); // 3 minutes for demo
  const [volume, setVolume] = useState(75);

  // Simulate playback
  useEffect(() => {
    if (isPlaying) {
      const interval = setInterval(() => {
        setCurrentTime((prev) => {
          if (prev >= duration) {
            setIsPlaying(false);
            return duration;
          }
          return prev + 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isPlaying, duration]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSeek = (value: number[]) => {
    setCurrentTime(value[0]);
  };

  const handleSkipBack = () => {
    setCurrentTime(Math.max(0, currentTime - 10));
  };

  const handleSkipForward = () => {
    setCurrentTime(Math.min(duration, currentTime + 10));
  };

  // Generate waveform visualization
  const generateWaveform = () => {
    const bars = 120;
    const waveform = [];
    for (let i = 0; i < bars; i++) {
      const height = Math.random() * 60 + 20;
      const progress = (i / bars) * 100;
      const isPast = progress <= (currentTime / duration) * 100;
      waveform.push(
        <div
          key={i}
          className={`w-1 rounded-full transition-all ${
            isPast ? 'bg-primary' : 'bg-muted'
          }`}
          style={{ height: `${height}%` }}
        />
      );
    }
    return waveform;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Button
        variant="ghost"
        onClick={onBack}
        className="gap-2"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Queue
      </Button>

      <div className="space-y-2">
        <h1>Now Playing</h1>
        <p className="text-muted-foreground">{bookTitle}</p>
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
            
            {/* Progress Indicator */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-primary transition-all"
              style={{ left: `${(currentTime / duration) * 100}%` }}
            />
          </div>

          {/* Timeline */}
          <div className="space-y-3">
            <Slider
              value={[currentTime]}
              onValueChange={handleSeek}
              min={0}
              max={duration}
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
            <Button
              size="icon"
              variant="outline"
              onClick={handleSkipBack}
              className="w-12 h-12"
            >
              <SkipBack className="w-5 h-5" />
            </Button>

            <Button
              size="icon"
              onClick={() => setIsPlaying(!isPlaying)}
              className="w-16 h-16 bg-primary hover:bg-primary/90 text-primary-foreground glow-purple"
            >
              {isPlaying ? (
                <Pause className="w-6 h-6" />
              ) : (
                <Play className="w-6 h-6 ml-0.5" />
              )}
            </Button>

            <Button
              size="icon"
              variant="outline"
              onClick={handleSkipForward}
              className="w-12 h-12"
            >
              <SkipForward className="w-5 h-5" />
            </Button>
          </div>

          {/* Volume Control */}
          <div className="flex items-center gap-4">
            <Volume2 className="w-5 h-5 text-muted-foreground shrink-0" />
            <Slider
              value={[volume]}
              onValueChange={(value) => setVolume(value[0])}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
            <span className="text-sm text-muted-foreground w-12 text-right">
              {volume}%
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Download Options */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Download Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Button
              variant="outline"
              className="gap-2 justify-start"
              onClick={onDownload}
            >
              <Download className="w-4 h-4" />
              <div className="text-left flex-1">
                <div>Download MP3</div>
                <div className="text-xs text-muted-foreground">Standard quality - 320kbps</div>
              </div>
            </Button>

            <Button
              variant="outline"
              className="gap-2 justify-start"
              onClick={onDownload}
            >
              <Download className="w-4 h-4" />
              <div className="text-left flex-1">
                <div>Download WAV</div>
                <div className="text-xs text-muted-foreground">Lossless quality</div>
              </div>
            </Button>
          </div>

          <div className="text-xs text-muted-foreground bg-muted/30 p-4 rounded-lg">
            <p>
              <strong>Note:</strong> Downloaded audiobooks are for personal use only. 
              Please respect copyright laws and the original content creator's rights.
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
              <span className="text-muted-foreground">Format:</span>
              <div>MP3, 320kbps</div>
            </div>
            <div>
              <span className="text-muted-foreground">File Size:</span>
              <div>7.2 MB</div>
            </div>
            <div>
              <span className="text-muted-foreground">Generated:</span>
              <div>Dec 4, 2024</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
