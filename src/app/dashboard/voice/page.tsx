<<<<<<< C:/Users/ntemu/Downloads/Echomancer-v2-new/src/app/dashboard/voice/page.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Upload, Loader2, Mic, ArrowLeft, Bookmark, Trash2 } from "lucide-react";
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { motion } from "motion/react";

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

  const [tab, setTab] = useState<"upload" | "saved">("upload");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
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

  return (
    <div className="max-w-2xl mx-auto pt-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center space-y-4 mb-8"
      >
        <h1 className="text-5xl md:text-6xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Choose voice</h1>
        <p className="text-lg text-muted-foreground font-serif">Upload your own recording</p>
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
                      {voice.source === "upload" ? "Upload" : "Saved"} • {new Date(voice.created_at).toLocaleDateString()}
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
=======
"use client";

import { Button } from "@/components/ui/button";
import { Upload, Loader2, Mic, ArrowLeft, Bookmark, Trash2 } from "lucide-react";
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { motion } from "motion/react";

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

  const [tab, setTab] = useState<"upload" | "saved">("upload");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
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
    const allowedAudioTypes = [
      "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
      "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/flac", "audio/x-flac",
      "audio/aac", "audio/x-ms-wma", "audio/opus", "audio/x-aiff", "audio/webm",
    ];
    if (!allowedAudioTypes.includes(uploadFile.type)) {
      toast.error("Invalid file type. Please upload an audio file (MP3, WAV, M4A, OGG, FLAC, AAC, WMA, OPUS, AIFF, WEBM).");
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

  return (
    <div className="max-w-2xl mx-auto pt-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center space-y-4 mb-8"
      >
        <h1 className="text-5xl md:text-6xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Choose voice</h1>
        <p className="text-lg text-muted-foreground font-serif">Upload your own recording</p>
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
                      {voice.source === "upload" ? "Upload" : "Saved"} • {new Date(voice.created_at).toLocaleDateString()}
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
>>>>>>> C:/Users/ntemu/.windsurf/worktrees/Echomancer-v2-new/Echomancer-v2-new-4e27da16/src/app/dashboard/voice/page.tsx
