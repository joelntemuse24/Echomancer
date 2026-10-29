"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { PlayerSeekGroup } from "@/components/player-seek-group";
import { PlayerSpeedControl } from "@/components/player-speed-control";
import { usePreciseSeek } from "@/hooks/use-precise-seek";
import { ReadAlongTranscript } from "@/components/read-along-transcript";
import { SKIP_SECONDS } from "@/lib/player/seek";
import type { ReadAlongDocument, ReadAlongPosition } from "@/lib/player/read-along";
import { cn } from "@/lib/utils";

function ThinPause({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <rect x="7" y="4" width="3" height="16" rx="0.75" />
      <rect x="14" y="4" width="3" height="16" rx="0.75" />
    </svg>
  );
}

function PlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

/** The transport's skip arc with its own number in the middle. */
function SkipGlyph({ seconds, direction }: { seconds: number; direction: "back" | "forward" }) {
  return (
    <span className="relative inline-flex h-8 w-8 items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        className={direction === "forward" ? "h-7 w-7 -scale-x-100" : "h-7 w-7"}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.35}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6.8 7.1a8 8 0 1 1-2.5 5.4" />
        <path d="M6.8 3.6v4h-4" />
      </svg>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center pt-0.5 text-[9px] font-medium leading-none">
        {seconds}
      </span>
    </span>
  );
}

const controlButton =
  "inline-flex items-center justify-center text-foreground transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30";

/**
 * Focus mode skips further than the inline transport, so a long book moves
 * in a few taps on a phone.
 */
export const FOCUS_SKIP_SECONDS = SKIP_SECONDS + 5;

/**
 * Focus (full-screen) read-along: the transcript fills the viewport with a
 * slim player bar pinned to the bottom. Uses the Fullscreen API where the
 * browser has it; iOS Safari has no element fullscreen, and some browsers
 * reject a request without a gesture, so the overlay always covers the
 * viewport with CSS too. Esc, the close control, and leaving browser
 * fullscreen all exit.
 */
export function ReadAlongFocus({
  document,
  position,
  onSeek,
  bookTitle,
  chapterTitle,
  playing,
  speed,
  currentTime,
  duration,
  streamMode,
  onToggle,
  onClose,
  onSkip,
  onScrub,
  onScrubCommit,
  onScrubActiveChange,
  onSpeedChange,
}: {
  document: ReadAlongDocument;
  position: ReadAlongPosition;
  onSeek?: (charIndex: number) => void;
  bookTitle: string;
  chapterTitle: string | null;
  playing: boolean;
  speed: number;
  currentTime: number;
  duration: number;
  streamMode: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSkip: (delta: number) => void;
  onScrub: (seconds: number) => void;
  onScrubCommit: (seconds: number) => void;
  onScrubActiveChange: (dragging: boolean) => void;
  onSpeedChange: (next: number) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  /** The same remembered preference the inline player bar uses. */
  const { preciseSeek, setPreciseSeek } = usePreciseSeek();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // The page behind stays put while the overlay is up.
  useEffect(() => {
    const previous = window.document.body.style.overflow;
    window.document.body.style.overflow = "hidden";
    return () => {
      window.document.body.style.overflow = previous;
    };
  }, []);

  // Ask for real fullscreen, but never depend on it.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    shell.requestFullscreen?.({ navigationUI: "hide" })?.catch(() => {
      // Refused (iOS, no gesture, embedded frame): the CSS overlay covers it.
    });
    return () => {
      if (window.document.fullscreenElement === shell) {
        window.document.exitFullscreen?.().catch(() => {});
      }
    };
  }, []);

  // Leaving browser fullscreen (Esc on a desktop browser) is the exit.
  useEffect(() => {
    const onChange = () => {
      if (window.document.fullscreenElement == null) onCloseRef.current();
    };
    window.document.addEventListener("fullscreenchange", onChange);
    return () => window.document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Esc always leaves focus mode. The browser also exits element fullscreen
  // on Esc (and fires fullscreenchange, which closes too), so both paths
  // agree. An open speed list is dismissed first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (shellRef.current?.querySelector('[role="listbox"]')) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-modal="true"
      aria-label="Read along, focus mode"
      data-focus-read-along=""
      className="fixed inset-0 z-[60] flex h-[100dvh] flex-col bg-background text-foreground"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-4 pt-3 md:px-8">
        <div className="min-w-0">
          <p className="truncate font-serif text-sm text-muted-foreground">{bookTitle}</p>
          {chapterTitle ? (
            <p className="truncate font-serif text-base text-foreground">{chapterTitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close focus mode"
            className={cn(controlButton, "min-h-11 min-w-11 gap-1.5 px-2")}
          >
            <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
            <span className="text-[11px] uppercase tracking-[0.12em]">Exit</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-3 pt-2 md:px-8">
        {/* No focus toggle inside the overlay: the header's Exit closes it. */}
        <ReadAlongTranscript document={document} position={position} onSeek={onSeek} fullscreen />
      </div>

      <div className="shrink-0 border-t border-foreground/10 bg-background/95 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
        <div className="mx-auto w-full max-w-[65ch] px-4 md:px-0">
          <PlayerSeekGroup
            currentTime={currentTime}
            duration={duration}
            disabled={streamMode}
            fineVisible={preciseSeek}
            onFineVisibleChange={setPreciseSeek}
            onScrub={onScrub}
            onScrubCommit={onScrubCommit}
            onScrubActiveChange={onScrubActiveChange}
          />
          <div className="flex items-center justify-between gap-2 pb-1">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => onSkip(-FOCUS_SKIP_SECONDS)}
                disabled={streamMode}
                aria-label={`Back ${FOCUS_SKIP_SECONDS} seconds`}
                className={cn(controlButton, "min-h-12 min-w-12")}
              >
                <SkipGlyph seconds={FOCUS_SKIP_SECONDS} direction="back" />
              </button>
              <button
                type="button"
                onClick={onToggle}
                aria-label={playing ? "Pause" : "Play"}
                className={cn(controlButton, "min-h-12 min-w-12")}
              >
                {playing ? <ThinPause className="h-7 w-7" /> : <PlayGlyph className="h-7 w-7" />}
              </button>
              <button
                type="button"
                onClick={() => onSkip(FOCUS_SKIP_SECONDS)}
                disabled={streamMode}
                aria-label={`Forward ${FOCUS_SKIP_SECONDS} seconds`}
                className={cn(controlButton, "min-h-12 min-w-12")}
              >
                <SkipGlyph seconds={FOCUS_SKIP_SECONDS} direction="forward" />
              </button>
            </div>
            <PlayerSpeedControl speed={speed} onSpeedChange={onSpeedChange} />
          </div>
        </div>
      </div>
    </div>
  );
}
