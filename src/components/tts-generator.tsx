"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ModalWarmupLoader } from "./modal-warmup-loader";
import { generateAudio } from "@/lib/modal-client";
import { toast } from "sonner";

interface TTSGeneratorProps {
  text: string;
  referenceAudioBase64: string;
}

function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(new ArrayBuffer(len));
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function TTSGenerator({ text, referenceAudioBase64 }: TTSGeneratorProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [showWarmup, setShowWarmup] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Revoke object URL on cleanup to prevent memory leaks
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    try {
      const result = await generateAudio(
        {
          texts: [text],
          reference_audio_base64: referenceAudioBase64,
          nfe_step: 32,
        },
        () => setShowWarmup(true), // onWarmupStart
        () => setShowWarmup(false) // onWarmupEnd
      );

      if (result.results[0]?.audio_base64) {
        const audioData = base64ToUint8Array(result.results[0].audio_base64);
        const blob = new Blob([audioData.buffer as ArrayBuffer], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        toast.success("Audio generated successfully!");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to generate audio");
    } finally {
      setIsGenerating(false);
      setShowWarmup(false);
    }
  };

  return (
    <>
      <ModalWarmupLoader isVisible={showWarmup} />
      
      <div className="space-y-4">
        <Button 
          onClick={handleGenerate} 
          disabled={isGenerating}
          className="w-full"
        >
          {isGenerating ? "Generating..." : "Generate Audio"}
        </Button>

        {audioUrl && (
          <audio controls className="w-full">
            <source src={audioUrl} type="audio/wav" />
            Your browser does not support the audio element.
          </audio>
        )}
      </div>
    </>
  );
}
