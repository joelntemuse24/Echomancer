"use client";

import { useState, useEffect } from "react";
import { Loader2, Cpu, Zap, Volume2 } from "lucide-react";

interface ModalWarmupLoaderProps {
  isVisible: boolean;
  onComplete?: () => void;
}

const stages = [
  { icon: Cpu, text: "Spinning up GPU...", duration: 15000 },
  { icon: Zap, text: "Loading AI voice model...", duration: 30000 },
  { icon: Volume2, text: "Ready to narrate!", duration: 5000 },
];

export function ModalWarmupLoader({ isVisible, onComplete }: ModalWarmupLoaderProps) {
  const [currentStage, setCurrentStage] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isVisible) {
      setCurrentStage(0);
      setProgress(0);
      return;
    }

    let totalTime = 0;
    const interval = setInterval(() => {
      totalTime += 100;
      const totalDuration = stages.reduce((sum, s) => sum + s.duration, 0);
      const newProgress = Math.min((totalTime / totalDuration) * 100, 100);
      setProgress(newProgress);

      // Determine current stage
      let elapsed = 0;
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        if (!stage) continue;
        elapsed += stage.duration;
        if (totalTime <= elapsed) {
          setCurrentStage(i);
          break;
        }
      }

      if (totalTime >= totalDuration) {
        clearInterval(interval);
        onComplete?.();
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isVisible, onComplete]);

  if (!isVisible) return null;

  const currentStageData = stages[currentStage];
  const StageIcon = currentStageData ? currentStageData.icon : Loader2;

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card border rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
          <h2 className="text-2xl font-semibold mb-2">Waking up AI Narrator</h2>
          <p className="text-muted-foreground">
            The AI is starting up. This takes about a minute on first use.
          </p>
        </div>

        {/* Progress Bar */}
        <div className="mb-6">
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-2">
            <span>0%</span>
            <span>{Math.round(progress)}%</span>
            <span>100%</span>
          </div>
        </div>

        {/* Stages */}
        <div className="space-y-3">
          {stages.map((stage, index) => {
            const Icon = stage.icon;
            const isActive = index === currentStage;
            const isComplete = index < currentStage;

            return (
              <div
                key={index}
                className={`flex items-center gap-3 p-3 rounded-lg transition-all duration-300 ${
                  isActive
                    ? "bg-primary/10 border border-primary/20"
                    : isComplete
                    ? "bg-green-500/10 text-green-600"
                    : "bg-secondary/50 text-muted-foreground"
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : isComplete
                      ? "bg-green-500 text-white"
                      : "bg-secondary"
                  }`}
                >
                  {isComplete ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                </div>
                <span className={`font-medium ${isActive ? "text-foreground" : ""}`}>
                  {stage.text}
                </span>
                {isActive && (
                  <Loader2 className="w-4 h-4 ml-auto animate-spin" />
                )}
              </div>
            );
          })}
        </div>

        {/* Tips */}
        <div className="mt-6 p-4 bg-blue-500/10 rounded-lg border border-blue-500/20">
          <p className="text-sm text-blue-600 dark:text-blue-400">
            <strong>💡 Tip:</strong> Subsequent requests will be much faster! 
            The AI stays warm for 5 minutes after each use.
          </p>
        </div>
      </div>
    </div>
  );
}
