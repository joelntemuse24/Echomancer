"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, Loader2, Mic } from "lucide-react";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

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
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = () => {
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

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Upload a Voice Sample</h1>
        <p className="text-muted-foreground">
          Upload an audio clip of the voice you want your audiobook narrated in.
          For best results, use 15-30 seconds of clean speech with no background noise.
        </p>
      </div>

      {/* Upload Area */}
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
                <li>Use <strong>15-30 seconds</strong> of clean speech</li>
                <li>No background music or noise</li>
                <li>Single speaker only</li>
                <li>Clear, natural speaking pace</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
