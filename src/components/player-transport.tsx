"use client";

import { Play, SkipBack, SkipForward } from "lucide-react";
import { SKIP_SECONDS } from "@/lib/player/seek";

function ThinPause({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <rect x="7" y="4" width="3" height="16" rx="0.75" />
      <rect x="14" y="4" width="3" height="16" rx="0.75" />
    </svg>
  );
}

function SkipTenIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <span className="relative inline-flex h-6 w-6 items-center justify-center md:h-7 md:w-7">
      <svg
        viewBox="0 0 24 24"
        className={
          direction === "forward"
            ? "h-6 w-6 -scale-x-100 md:h-7 md:w-7"
            : "h-6 w-6 md:h-7 md:w-7"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6.8 7.1a8 8 0 1 1-2.5 5.4" />
        <path d="M6.8 3.6v4h-4" />
      </svg>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center pt-0.5 text-[9px] font-medium leading-none md:text-[10px]">
        {SKIP_SECONDS}
      </span>
    </span>
  );
}

const buttonClass =
  "inline-flex items-center justify-center text-foreground transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30";

export function PlayerTransport({
  audioReady,
  playing,
  skipDisabled,
  showChapters,
  previousDisabled,
  nextDisabled,
  onToggle,
  onSkip,
  onPrevious,
  onNext,
}: {
  audioReady: boolean;
  playing: boolean;
  skipDisabled: boolean;
  showChapters: boolean;
  previousDisabled: boolean;
  nextDisabled: boolean;
  onToggle: () => void;
  onSkip: (delta: number) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const target = showChapters ? "min-h-12 min-w-12" : "min-h-11 min-w-11";
  return (
    <div
      className={`flex items-center ${showChapters ? "gap-4 md:gap-8" : "gap-8 md:gap-14"}`}
    >
      {audioReady && showChapters ? (
        <button
          type="button"
          data-testid="chapter-previous"
          aria-label="Previous chapter"
          onClick={onPrevious}
          disabled={previousDisabled || skipDisabled}
          className={`${buttonClass} min-h-12 min-w-12`}
        >
          <SkipBack aria-hidden="true" className="h-5 w-5" strokeWidth={1.5} />
        </button>
      ) : null}
      {audioReady ? (
        <button
          type="button"
          aria-label="Back 10 seconds"
          onClick={() => onSkip(-SKIP_SECONDS)}
          disabled={skipDisabled}
          className={`${buttonClass} ${target}`}
        >
          <SkipTenIcon direction="back" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onToggle}
        disabled={!audioReady}
        aria-label={playing ? "Pause" : "Play"}
        className={`${buttonClass} ${target}`}
      >
        {playing ? (
          <ThinPause className="h-8 w-8 md:h-10 md:w-10" />
        ) : (
          <Play aria-hidden="true" className="ml-0.5 h-8 w-8 md:h-10 md:w-10" />
        )}
      </button>
      {audioReady ? (
        <button
          type="button"
          aria-label="Forward 10 seconds"
          onClick={() => onSkip(SKIP_SECONDS)}
          disabled={skipDisabled}
          className={`${buttonClass} ${target}`}
        >
          <SkipTenIcon direction="forward" />
        </button>
      ) : null}
      {audioReady && showChapters ? (
        <button
          type="button"
          data-testid="chapter-next"
          aria-label="Next chapter"
          onClick={onNext}
          disabled={nextDisabled || skipDisabled}
          className={`${buttonClass} min-h-12 min-w-12`}
        >
          <SkipForward aria-hidden="true" className="h-5 w-5" strokeWidth={1.5} />
        </button>
      ) : null}
    </div>
  );
}
