"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  PLAYBACK_SPEED_PRESETS,
  formatPlaybackSpeed,
  nextPlaybackSpeed,
} from "@/lib/player/playback-speed";

export function PlayerSpeedControl({
  speed,
  onSpeedChange,
}: {
  speed: number;
  onSpeedChange: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative z-30 inline-flex items-center">
      <button
        type="button"
        aria-label={`Playback speed ${speed}x, tap to change`}
        onClick={() => {
          onSpeedChange(nextPlaybackSpeed(speed));
          setOpen(false);
        }}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {formatPlaybackSpeed(speed)}
      </button>
      <button
        type="button"
        aria-label="Choose playback speed"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ml-px p-2 -mr-2 text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.5}
        />
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-20 bg-background"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <ul
            role="listbox"
            aria-label="Playback speed"
            className="absolute left-1/2 z-30 max-h-[min(22rem,55vh)] min-w-[5.5rem] -translate-x-1/2 overflow-y-auto rounded-md border border-border/50 bg-background py-1 shadow-xl bottom-full mb-2 md:bottom-auto md:top-full md:mb-0 md:mt-2"
          >
            {PLAYBACK_SPEED_PRESETS.map((rate) => {
              const selected = Math.abs(rate - speed) < 0.001;
              return (
                <li key={rate} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onSpeedChange(rate);
                      setOpen(false);
                    }}
                    className={`block w-full px-3 py-1.5 text-xs transition-colors ${
                      selected
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {formatPlaybackSpeed(rate)}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
