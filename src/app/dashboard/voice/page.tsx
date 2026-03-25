"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, Loader2, Mic, Search, Youtube, Clock } from "lucide-react";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
}

export default function VoiceSelectionPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}>
      <VoiceSelectionContent />
    </Suspense>
  );
}

function VoiceSelectionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pdfPath = searchParams.get("pdfPath") || "";
  const pdfName = searchParams.get("pdfName") || "";

  const [tab, setTab] = useState<"upload" | "youtube">("upload");
  const [isUploading, setIsUploading] = useState(false);

  // YouTube search state
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);

  const handleUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.mp3,.wav,.m4a,.ogg";
    input.onchange = async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      // Zonos works best with 15-30s samples (~1-5MB)
      // Reject files larger than 10MB to prevent timeouts
      if (file.size > 10 * 1024 * 1024) {
        toast.error("File too large. Maximum size is 10MB. Please upload a 15-30 second voice sample.");
        return;
      }
      
      // Warn if file seems too large for a voice sample
      if (file.size > 5 * 1024 * 1024) {
        toast.warning("Large file detected. For best results, use a 15-30 second voice sample.");
      }

      setIsUploading(true);
      toast.info("Uploading audio file...");

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/api/audio/upload", { method: "POST", body: formData });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || "Upload failed");

        toast.success("Audio uploaded!");
        router.push(
          `/dashboard/voice/clip?pdfPath=${encodeURIComponent(pdfPath)}&pdfName=${encodeURIComponent(pdfName)}&voicePath=${encodeURIComponent(data.storagePath)}&videoTitle=${encodeURIComponent(file.name)}&isUpload=true`
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Upload failed";
        toast.error(message);
      } finally {
        setIsUploading(false);
      }
    };
    input.click();
  };

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!searchQuery.trim() || isSearching) return;

    setIsSearching(true);
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(searchQuery)}&maxResults=8`);
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Search failed");

      setVideos(data.videos || []);
      if ((data.videos || []).length === 0) {
        toast.info("No results found. Try a different search term.");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Search failed";
      toast.error(message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectVideo = (video: YouTubeVideo) => {
    router.push(
      `/dashboard/voice/clip?pdfPath=${encodeURIComponent(pdfPath)}&pdfName=${encodeURIComponent(pdfName)}&videoId=${encodeURIComponent(video.id)}&videoTitle=${encodeURIComponent(video.title)}`
    );
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Choose a Voice</h1>
        <p className="text-muted-foreground">
          Upload your own audio sample or find a voice on YouTube.
          For best results, use 15-30 seconds of clean speech with no background noise.
        </p>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-2 p-1 bg-muted/30 rounded-lg w-fit">
        <Button
          variant={tab === "upload" ? "default" : "ghost"}
          className="gap-2"
          onClick={() => setTab("upload")}
        >
          <Upload className="w-4 h-4" />
          Upload Audio
        </Button>
        <Button
          variant={tab === "youtube" ? "default" : "ghost"}
          className="gap-2"
          onClick={() => setTab("youtube")}
        >
          <Youtube className="w-4 h-4" />
          YouTube Search
        </Button>
      </div>

      {/* Upload Tab */}
      {tab === "upload" && (
        <Card
          className="bg-card border-2 border-dashed border-border hover:border-primary transition-colors cursor-pointer"
          onClick={handleUpload}
        >
          <CardContent className="p-12">
            <div className="flex flex-col items-center justify-center space-y-6">
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                {isUploading ? (
                  <Loader2 className="w-10 h-10 text-primary animate-spin" />
                ) : (
                  <Upload className="w-10 h-10 text-primary" />
                )}
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-xl font-semibold">
                  {isUploading ? "Uploading..." : "Click to upload a voice sample"}
                </h3>
                <p className="text-muted-foreground">
                  MP3, WAV, M4A, or OGG — Max 50MB
                </p>
              </div>
              <Button variant="outline" className="gap-2" disabled={isUploading}>
                <Upload className="w-4 h-4" />
                Choose File
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* YouTube Tab */}
      {tab === "youtube" && (
        <div className="space-y-6">
          <form onSubmit={handleSearch} className="flex gap-3">
            <Input
              placeholder="Search for a voice on YouTube (e.g. 'Morgan Freeman narration')..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" disabled={isSearching || !searchQuery.trim()} className="gap-2">
              {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </Button>
          </form>

          {/* Results */}
          {videos.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {videos.map((video) => (
                <Card
                  key={video.id}
                  className="bg-card border-border hover:border-primary transition-colors cursor-pointer overflow-hidden"
                  onClick={() => handleSelectVideo(video)}
                >
                  <div className="relative">
                    {video.thumbnail && (
                      <img
                        src={video.thumbnail}
                        alt={video.title}
                        className="w-full aspect-video object-cover"
                      />
                    )}
                    {video.duration && (
                      <span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {video.duration}
                      </span>
                    )}
                  </div>
                  <CardContent className="p-4 space-y-1">
                    <h4 className="font-medium text-sm line-clamp-2">{video.title}</h4>
                    <p className="text-xs text-muted-foreground">{video.channel}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {videos.length === 0 && !isSearching && (
            <Card className="bg-card border-border">
              <CardContent className="p-12 text-center space-y-4">
                <Youtube className="w-12 h-12 text-muted-foreground mx-auto" />
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold">Search YouTube for a voice</h3>
                  <p className="text-muted-foreground text-sm">
                    Find a podcast, narration, or speech — we&apos;ll extract the audio and use it for voice cloning
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Tips */}
      <Card className="bg-muted/30 border-border">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Mic className="w-5 h-5 text-primary" />
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold">Tips for best voice cloning</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>Use <strong>15-30 seconds</strong> of clean speech (max 10MB file)</li>
                <li>No background music or noise</li>
                <li>Single speaker only</li>
                <li>Clear, natural speaking pace</li>
                <li className="text-amber-500">⚠️ Large files will be rejected (causes timeouts)</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
