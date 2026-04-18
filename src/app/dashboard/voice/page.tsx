"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Upload, Loader2, Mic, Search, ArrowLeft, Play, Scissors, CheckCircle2, Bookmark, Trash2 } from "lucide-react";
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";

interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
  durationSeconds: number;
  publishedAt: string;
}

export default function VoiceSelectionPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-[#D97757]" /></div>}>
      <VoiceSelectionContent />
    </Suspense>
  );
}

function VoiceSelectionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pdfPath = searchParams.get("pdfPath") || "";
  const pdfName = searchParams.get("pdfName") || "";

  const [tab, setTab] = useState<"upload" | "youtube" | "saved">("upload");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  
  // YouTube clip selection state
  const [selectedVideo, setSelectedVideo] = useState<YouTubeVideo | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(30);
  const [isDownloading, setIsDownloading] = useState(false);
  const [savedVoices, setSavedVoices] = useState<Array<{ id: string; name: string; storage_path: string; source: string; source_video_id: string | null; created_at: string }>>([]);

  // Fetch saved voices
  useEffect(() => {
    if (tab === "saved") {
      fetch("/api/voices").then(r => r.json()).then(data => setSavedVoices(data.voices || [])).catch(() => {});
    }
  }, [tab]);

  const handleUpload = async () => {
    if (!uploadFile) return;
    if (uploadFile.size > 10 * 1024 * 1024) {
      toast.error("File too large. Maximum size is 10MB. Please upload a shorter voice sample (15-30 seconds).");
      return;
    }
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      const res = await fetch("/api/audio/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      toast.success("Audio uploaded!");
      router.push(
        `/dashboard/voice/clip?pdfPath=${encodeURIComponent(pdfPath)}&pdfName=${encodeURIComponent(pdfName)}&voicePath=${encodeURIComponent(data.storagePath)}&videoTitle=${encodeURIComponent(uploadFile.name)}&isUpload=true`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Upload failed";
      toast.error(message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!searchQuery.trim() || isSearching) return;
    setIsSearching(true);
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(searchQuery)}&maxResults=6`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");
      setVideos(data.videos || []);
      if ((data.videos || []).length === 0) toast.info("No results found.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Search failed";
      toast.error(message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectVideo = (video: YouTubeVideo) => {
    setSelectedVideo(video);
    setStartTime(0);
    setEndTime(Math.min(30, video.durationSeconds || 30));
  };

  const handleBackToSearch = () => {
    setSelectedVideo(null);
    setStartTime(0);
    setEndTime(30);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleSliderChange = (values: number[]) => {
    const newStart = values[0] ?? 0;
    let newEnd = values[1] ?? 30;
    const maxClipDuration = 30;
    if (newEnd - newStart > maxClipDuration) {
      newEnd = newStart + maxClipDuration;
    }
    setStartTime(newStart);
    setEndTime(newEnd);
  };

  const handleDownloadClip = async () => {
    if (!selectedVideo) return;
    const clipDuration = endTime - startTime;
    if (clipDuration < 3) {
      toast.error("Clip must be at least 3 seconds");
      return;
    }
    if (clipDuration > 30) {
      toast.error("Clip must be 30 seconds or less");
      return;
    }

    setIsDownloading(true);
    try {
      toast.info("Downloading voice sample...");
      const res = await fetch("/api/youtube/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: selectedVideo.id,
          startTime,
          endTime,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Download failed");

      // Navigate to clip page so user can preview before committing
      router.push(
        `/dashboard/voice/clip?pdfPath=${encodeURIComponent(pdfPath)}&pdfName=${encodeURIComponent(pdfName)}&voicePath=${encodeURIComponent(data.storagePath)}&videoTitle=${encodeURIComponent(selectedVideo.title)}&videoId=${encodeURIComponent(selectedVideo.id)}&isUpload=false`
      );
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Download failed");
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto pt-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center space-y-4 mb-8"
      >
        <h1 className="text-5xl md:text-6xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Choose voice</h1>
        <p className="text-lg text-muted-foreground font-serif">Upload your own recording or select a voice from YouTube</p>
      </motion.div>

      {/* PDF pill */}
      <div className="flex justify-center mb-8">
        <button
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent border border-border/50 text-xs text-muted-foreground hover:border-border transition-colors"
          onClick={() => router.push("/")}
        >
          <ArrowLeft className="w-3 h-3" />
          <span className="max-w-[180px] truncate">{pdfName}</span>
        </button>
      </div>

      {/* Tab switcher */}
      <div className="flex justify-center mb-10">
        <div className="inline-flex bg-accent border border-border/50 rounded-sm p-1">
          <button
            className={`px-8 py-3 text-sm uppercase tracking-wider rounded-sm transition-all ${
              tab === "upload" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("upload")}
          >
            Upload
          </button>
          <button
            className={`px-8 py-3 text-sm uppercase tracking-wider rounded-sm transition-all ${
              tab === "youtube" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("youtube")}
          >
            YouTube
          </button>
          <button
            className={`px-8 py-3 text-sm uppercase tracking-wider rounded-sm transition-all ${
              tab === "saved" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("saved")}
          >
            Saved
          </button>
        </div>
      </div>

      {/* Upload */}
      {tab === "upload" && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div
            className="border border-border rounded-sm p-12 text-center cursor-pointer hover:border-foreground/30 group transition-all"
            onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) setUploadFile(file); }}
            onDragOver={(e) => e.preventDefault()}
          >
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.wma,.opus,.aiff,.webm"
              onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              className="hidden"
              id="voice-upload"
            />
            <label htmlFor="voice-upload" className="cursor-pointer">
              <div className="mx-auto w-12 h-12 flex items-center justify-center mb-6 text-muted-foreground group-hover:text-foreground transition-colors">
                {isUploading ? <Loader2 className="w-12 h-12 animate-spin" /> : <Mic className="w-12 h-12" />}
              </div>
              <div className="text-sm uppercase tracking-wider mb-2 font-serif">
                {uploadFile ? uploadFile.name : 'Voice sample'}
              </div>
              <div className="text-xs text-muted-foreground">Any audio format • Max 10MB</div>
            </label>
          </div>
          <Button
            onClick={handleUpload}
            disabled={!uploadFile || isUploading}
            className="w-full mt-8 h-12"
          >
            Continue with this voice
          </Button>
        </motion.div>
      )}

      {/* YouTube */}
      {tab === "youtube" && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
          <AnimatePresence mode="wait">
            {!selectedVideo ? (
              <motion.div key="search" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6">
                <div className="relative">
                  <Search className="absolute left-6 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Search YouTube for a voice..."
                    className="w-full h-14 pl-14 pr-28 bg-background border border-border rounded-sm text-foreground placeholder:text-muted-foreground focus:border-foreground/30 focus:outline-none transition-all"
                  />
                  <Button
                    onClick={handleSearch}
                    disabled={isSearching || !searchQuery.trim()}
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                  >
                    {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
                  </Button>
                </div>

                {videos.length > 0 && (
                  <div className="grid gap-4 max-h-[400px] overflow-y-auto pr-1">
                    {videos.map((video) => (
                      <motion.button
                        key={video.id}
                        onClick={() => handleSelectVideo(video)}
                        className="w-full flex gap-4 p-4 border border-border rounded-sm hover:border-foreground/30 text-left transition-all"
                        whileHover={{ scale: 1.01 }}
                      >
                        <div className="relative w-32 h-20 shrink-0 rounded-sm overflow-hidden">
                          {video.thumbnail && (
                            <img src={video.thumbnail} alt="" className="w-full h-full object-cover" />
                          )}
                          <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                            <Play className="w-8 h-8 text-white" />
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium line-clamp-2 font-serif">{video.title}</div>
                          <div className="text-xs text-muted-foreground mt-1">{video.channel} • {video.duration}</div>
                        </div>
                      </motion.button>
                    ))}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div key="player" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
                {/* Back button */}
                <button
                  onClick={handleBackToSearch}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to results
                </button>

                {/* Video title */}
                <div>
                  <h2 className="font-serif text-lg line-clamp-2">{selectedVideo.title}</h2>
                  <p className="text-xs text-muted-foreground mt-1">{selectedVideo.channel}</p>
                </div>

                {/* YouTube Player */}
                <div className="relative aspect-video rounded-sm overflow-hidden bg-black">
                  <iframe
                    src={`https://www.youtube.com/embed/${selectedVideo.id}?enablejsapi=1&origin=${typeof window !== 'undefined' ? window.location.origin : ''}`}
                    className="w-full h-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>

                {/* Time selection */}
                <div className="space-y-4 p-4 border border-border rounded-sm bg-accent/20">
                  <div className="flex items-center gap-2">
                    <Scissors className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Select voice sample</span>
                    <span className="text-xs text-muted-foreground ml-auto">3-30 seconds</span>
                  </div>

                  {/* Time display */}
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-muted-foreground">Start: {formatTime(startTime)}</span>
                    <span className="text-muted-foreground">End: {formatTime(endTime)}</span>
                  </div>

                  {/* Duration badge */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Clip duration</span>
                    <span className={`text-sm font-mono font-medium ${
                      endTime - startTime < 3 ? "text-yellow-500" :
                      endTime - startTime > 30 ? "text-destructive" :
                      "text-emerald-500"
                    }`}>
                      {formatTime(endTime - startTime)}
                    </span>
                  </div>

                  {/* Slider */}
                  <Slider
                    value={[startTime, endTime]}
                    onValueChange={handleSliderChange}
                    min={0}
                    max={selectedVideo.durationSeconds || 300}
                    step={1}
                    minStepsBetweenThumbs={3}
                    className="w-full"
                  />

                  {/* Warning messages */}
                  {endTime - startTime < 3 && (
                    <p className="text-xs text-yellow-500">Clip must be at least 3 seconds</p>
                  )}
                  {endTime - startTime > 30 && (
                    <p className="text-xs text-destructive">Clip must be 30 seconds or less</p>
                  )}
                </div>

                {/* Download button */}
                <Button
                  onClick={handleDownloadClip}
                  disabled={isDownloading || endTime - startTime < 3 || endTime - startTime > 30}
                  className="w-full h-12"
                >
                  {isDownloading ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <><CheckCircle2 className="w-4 h-4 mr-2" />Use this voice sample</>
                  )}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Saved Voices */}
      {tab === "saved" && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          {savedVoices.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-border/50 rounded-sm">
              <Bookmark className="w-8 h-8 mx-auto mb-3 text-muted-foreground/50" />
              <p className="text-muted-foreground">No saved voices yet.</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Voices you use will appear here for quick reuse.</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {savedVoices.map((voice) => (
                <div key={voice.id} className="flex items-center gap-4 p-4 border border-border rounded-sm hover:border-foreground/30 transition-all group">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{voice.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {voice.source === "youtube" ? "YouTube" : "Upload"} • {new Date(voice.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      router.push(
                        `/dashboard/voice/clip?pdfPath=${encodeURIComponent(pdfPath)}&pdfName=${encodeURIComponent(pdfName)}&voicePath=${encodeURIComponent(voice.storage_path)}&videoTitle=${encodeURIComponent(voice.name)}&isUpload=${voice.source === "upload"}`
                      );
                    }}
                    className="shrink-0"
                  >
                    Use
                  </Button>
                  <button
                    onClick={async () => {
                      try {
                        await fetch(`/api/voices?id=${voice.id}`, { method: "DELETE" });
                        setSavedVoices(prev => prev.filter(v => v.id !== voice.id));
                        toast.success("Voice removed");
                      } catch { toast.error("Failed to remove"); }
                    }}
                    className="text-muted-foreground hover:text-destructive transition-colors p-1 shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}

      {/* Step dots */}
      <div className="flex items-center justify-center gap-2 mt-8">
        <span className="w-1.5 h-1.5 rounded-full bg-[#7a8f7e]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#D97757]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#2a2a2a]" />
      </div>
    </div>
  );
}
