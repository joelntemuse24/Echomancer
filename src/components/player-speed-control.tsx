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
        aria-label="Playback speed"
        onClick={() => {
          onSpeedChange(nextPlaybackSpeed(speed));
          setOpen(false);
        }}
        className="inline-flex min-h-11 items-center text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {formatPlaybackSpeed(speed)}
      </button>
      <button
        type="button"
        aria-label="Choose speed"
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
            className="fixed inset-0 z-20 bg-background md:hidden"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <ul
            role="listbox"
            aria-label="Speed"
            className="absolute bottom-full left-1/2 z-30 mb-2 max-h-[min(22rem,55vh)] min-w-[5.5rem] -translate-x-1/2 overflow-y-auto bg-background py-1 md:bottom-auto md:top-full md:mb-0 md:mt-2"
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
                    className={`flex min-h-11 w-full items-center justify-center px-3 text-xs transition-colors ${
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
