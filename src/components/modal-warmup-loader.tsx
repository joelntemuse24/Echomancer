"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Cpu, Zap, Volume2 } from "lucide-react";

interface ModalWarmupLoaderProps {
  isVisible: boolean;
  onComplete?: () => void;
}

type WarmupStage = "connecting" | "loading" | "ready";

export function ModalWarmupLoader({ isVisible, onComplete }: ModalWarmupLoaderProps) {
  const [stage, setStage] = useState<WarmupStage>("connecting");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  useEffect(() => {
    cleanup();
    completedRef.current = false;

    if (!isVisible) {
      setStage("connecting");
      setElapsedSeconds(0);
      return;
    }

    // Elapsed-time counter
    timerRef.current = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);

    // Poll Modal health endpoint to track real warmup status
    const modalUrl = process.env.NEXT_PUBLIC_MODAL_TTS_URL;
    const baseUrl = modalUrl
      ? modalUrl.replace("/generate_batch", "")
      : "";

    const checkHealth = async () => {
      if (completedRef.current) return;
      try {
        const res = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          setStage("loading");
          // Try warmup endpoint to confirm GPU containers are ready
          try {
            const warmupRes = await fetch(`${baseUrl}/warmup`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ containers: 1 }),
              signal: AbortSignal.timeout(60000),
            });
            if (warmupRes.ok) {
              setStage("ready");
              completedRef.current = true;
              cleanup();
              setTimeout(() => onComplete?.(), 1500);
              return;
            }
          } catch {
            // Warmup still loading, keep polling
          }
        }
      } catch {
        // Still connecting
      }
    };

    // Initial check immediately, then poll every 3 seconds
    checkHealth();
    pollRef.current = setInterval(checkHealth, 3000);

    // Safety timeout: complete after 90s regardless
    const safetyTimeout = setTimeout(() => {
      if (!completedRef.current) {
        completedRef.current = true;
        setStage("ready");
        cleanup();
        onComplete?.();
      }
    }, 90000);

    return () => {
      cleanup();
      clearTimeout(safetyTimeout);
    };
  }, [isVisible, onComplete, cleanup]);

  if (!isVisible) return null;

  const stages = [
    { key: "connecting" as const, icon: Cpu, text: "Connecting to GPU server..." },
    { key: "loading" as const, icon: Zap, text: "Loading AI voice model..." },
    { key: "ready" as const, icon: Volume2, text: "Ready to narrate!" },
  ];

  const currentIndex = stages.findIndex((s) => s.key === stage);
  const progress =
    stage === "ready" ? 100 : stage === "loading" ? 60 : Math.min(30, elapsedSeconds * 2);

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
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-2">
            <span>{elapsedSeconds}s</span>
            <span>{Math.round(progress)}%</span>
          </div>
        </div>

        {/* Stages */}
        <div className="space-y-3">
          {stages.map((s, index) => {
            const Icon = s.icon;
            const isActive = index === currentIndex;
            const isComplete = index < currentIndex;

            return (
              <div
                key={s.key}
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
                  {s.text}
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
            <strong>Tip:</strong> Subsequent requests will be much faster!
            The AI stays warm for 10 minutes after each use.
          </p>
        </div>
      </div>
    </div>
  );
}
