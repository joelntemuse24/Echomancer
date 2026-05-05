"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ModalWarmupLoader } from "./modal-warmup-loader";
import { generateAudio } from "@/lib/modal-client";
import { toast } from "sonner";

interface TTSGeneratorProps {
  text: string;
  referenceAudioBase64: string;
}

export function TTSGenerator({ text, referenceAudioBase64 }: TTSGeneratorProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [showWarmup, setShowWarmup] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setAudioUrl(null);

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
        const audioData = Buffer.from(result.results[0].audio_base64, "base64");
        const blob = new Blob([audioData], { type: "audio/wav" });
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
