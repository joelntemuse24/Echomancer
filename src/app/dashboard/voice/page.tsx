"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Clock, Upload, Loader2 } from "lucide-react";
import { useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

interface Video {
  id: string;
  title: string;
  channel: string;
  duration?: string;
  thumbnail: string;
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

  const [searchQuery, setSearchQuery] = useState("");
  const [videos, setVideos] = useState<Video[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(searchQuery.trim())}&maxResults=12`);
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Search failed");

      setVideos(data.videos || []);
      if (data.videos?.length === 0) {
        toast.info("No videos found. Try a different search term.");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Search failed";
      toast.error(message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleVideoSelected = (videoId: string, videoTitle: string) => {
    router.push(
      `/dashboard/voice/clip?pdfPath=${encodeURIComponent(pdfPath)}&pdfName=${encodeURIComponent(pdfName)}&videoId=${encodeURIComponent(videoId)}&videoTitle=${encodeURIComponent(videoTitle)}`
    );
  };

  const handleManualUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.mp3,.wav,.m4a,.ogg";
    input.onchange = async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      if (file.size > 50 * 1024 * 1024) {
        toast.error("File too large. Maximum size is 50MB.");
        return;
      }

      toast.info("Uploading audio file...");

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/api/audio/upload", { method: "POST", body: formData });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || "Upload failed");

        toast.success("Audio uploaded! Proceeding to voice clipping...");
        router.push(
          `/dashboard/voice/clip?pdfPath=${encodeURIComponent(pdfPath)}&pdfName=${encodeURIComponent(pdfName)}&voicePath=${encodeURIComponent(data.storagePath)}&videoTitle=${encodeURIComponent(file.name)}&isUpload=true`
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Upload failed";
        toast.error(message);
      }
    };
    input.click();
  };

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Select a Voice</h1>
        <p className="text-muted-foreground">
          Search YouTube for videos with voices you&apos;d like to use, or upload your own audio sample
        </p>
      </div>

      {/* Search Bar */}
      <Card className="bg-card border-border">
        <CardContent className="p-6">
          <form onSubmit={handleSearch} className="space-y-4">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted-foreground z-10" />
              <Input
                ref={searchInputRef}
                type="text"
                placeholder="Search for voices on YouTube... (e.g., 'audiobook narration', 'documentary voice')"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-12 pr-24 py-6 text-lg bg-background border-2 border-border focus:border-primary"
                disabled={isSearching}
              />
              {isSearching ? (
                <Loader2 className="absolute right-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-primary animate-spin" />
              ) : (
                <Button type="submit" className="absolute right-2 top-1/2 transform -translate-y-1/2" size="sm">
                  Search
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Manual Upload Option */}
      <Card className="bg-card border-border border-dashed hover:border-primary transition-colors">
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4 flex-1">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Upload className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h4 className="font-semibold">Upload Your Own Audio Sample</h4>
                <p className="text-sm text-muted-foreground">
                  Have a voice recording? Upload MP3, WAV, or M4A files directly
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Supported formats: MP3, WAV, M4A, OGG - Max 50MB
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={handleManualUpload} className="gap-2 min-w-[140px]">
              <Upload className="w-4 h-4" />
              Upload Audio
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Video Grid */}
      <div className="space-y-4">
        {videos.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Search Results</h3>
              <p className="text-sm text-muted-foreground">{videos.length} videos found</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {videos.map((video) => (
                <Card
                  key={video.id}
                  className="bg-card border-border hover:border-primary transition-all cursor-pointer group"
                  onClick={() => handleVideoSelected(video.id, video.title)}
                >
                  <CardContent className="p-0">
                    <div className="relative aspect-video bg-muted overflow-hidden rounded-t-lg">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={video.thumbnail}
                        alt={video.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      {video.duration && (
                        <div className="absolute bottom-2 right-2 bg-black/80 text-white px-2 py-1 rounded text-xs flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {video.duration}
                        </div>
                      )}
                    </div>
                    <div className="p-4 space-y-2">
                      <h4 className="font-semibold line-clamp-2 group-hover:text-primary transition-colors">
                        {video.title}
                      </h4>
                      <p className="text-sm text-muted-foreground">{video.channel}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}

        {videos.length === 0 && !isSearching && (
          <Card
            className="bg-muted/30 border-border hover:border-primary/50 transition-colors cursor-pointer"
            onClick={() => searchInputRef.current?.focus()}
          >
            <CardContent className="p-12">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
                  <Search className="w-8 h-8 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">Ready to search</h3>
                  <p className="text-muted-foreground">
                    Enter a search term above to find YouTube videos with voices you want to use, or upload your own audio sample.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={(e) => {
                      e.stopPropagation();
                      searchInputRef.current?.focus();
                    }}
                  >
                    <Search className="w-4 h-4 mr-2" />
                    Start Searching
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
