"use client";

import { useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { fineSeekWindow, formatPlayClock } from "@/lib/player/seek";

interface PlayerSeekGroupProps {
  currentTime: number;
  duration: number;
  /** Stream mode: the bars stay visible but inert, and fine tune is off. */
  disabled?: boolean;
  /** Whether the fine slider is up. The page owns this so it resets per book. */
  fineVisible: boolean;
  /** Live scrub position (held drag or keyboard step). */
  onScrub: (seconds: number) => void;
  /** A finished seek. The page applies it to the audio element. */
  onScrubCommit: (seconds: number) => void;
  /** True while a pointer drag is held; the page freezes playhead updates for that window. */
  onScrubActiveChange?: (dragging: boolean) => void;
  /** First interaction with the seek bar. The page lifts the fine slider for the rest of the visit. */
  onFineReveal?: () => void;
}

/**
 * Seek bar, clocks, and the fine-tune window. The fine slider never hides
 * itself: once the page has lifted it (long audio from load, shorter audio
 * on the first scrub) only a book change brings it back down. Its window
 * follows the playhead on a half-minute grid — a seek always lands inside,
 * playback slides it at most once a minute — and a held fine drag pins it
 * so the thumb cannot slip under the finger. The pin lifts on any drag end
 * (commit, stationary tap, or interrupted pointer), never on a timer.
 */
export function PlayerSeekGroup({
  currentTime,
  duration,
  disabled = false,
  fineVisible,
  onScrub,
  onScrubCommit,
  onScrubActiveChange,
  onFineReveal,
}: PlayerSeekGroupProps) {
  /** Window frozen for the fine drag in progress, else null. */
  const [pinned, setPinned] = useState<{ start: number; end: number } | null>(null);
  const pointerHeld = useRef(false);

  const fineRange = fineVisible && !disabled
    ? fineSeekWindow(currentTime, duration, pinned)
    : null;

  const handleValueChange = (value: number[]) => {
    // Keyboard steps also fire this, after commit. Only a held pointer is a
    // drag, so an arrow key does not freeze the playhead.
    if (pointerHeld.current) onScrubActiveChange?.(true);
    onScrub(value[0] ?? 0);
    onFineReveal?.();
  };

  /**
   * Radix only fires onValueCommit when the value actually changed, so a
   * stationary tap or a drag that lands exactly where it started never
   * commits. Every drag end must still release the held-pointer flag and
   * the fine window pin, or the playhead stops tracking until the next
   * real seek. Pointer-up covers the common path; lost capture and
   * pointercancel cover interrupted drags; blur covers stray focus.
   */
  const releaseDrag = () => {
    pointerHeld.current = false;
    setPinned(null);
    onScrubActiveChange?.(false);
  };

  const handleCommit = (value: number[]) => {
    releaseDrag();
    onScrubCommit(value[0] ?? 0);
  };

  return (
    <div className="w-full space-y-2">
      <Slider
        aria-label="Seek"
        value={[currentTime]}
        onPointerDown={() => {
          pointerHeld.current = true;
          onFineReveal?.();
        }}
        onPointerUp={releaseDrag}
        onPointerCancel={releaseDrag}
        onLostPointerCapture={releaseDrag}
        onBlur={releaseDrag}
        onValueChange={handleValueChange}
        onValueCommit={handleCommit}
        min={0}
        max={duration || 1}
        step={0.1}
        disabled={disabled}
        className={`w-full ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
        <span>{formatPlayClock(currentTime)}</span>
        <span>{disabled ? "—" : formatPlayClock(duration)}</span>
      </div>
      {fineRange ? (
        <div className="space-y-1 pt-1">
          <p className="text-center text-[11px] text-muted-foreground">
            Fine tune {formatPlayClock(fineRange.start)}–{formatPlayClock(fineRange.end)}
          </p>
          <Slider
            aria-label="Fine tune"
            value={[
              Math.min(fineRange.end, Math.max(fineRange.start, currentTime)),
            ]}
            onPointerDown={() => {
              pointerHeld.current = true;
              setPinned(fineRange);
            }}
            onPointerUp={releaseDrag}
            onPointerCancel={releaseDrag}
            onLostPointerCapture={releaseDrag}
            onBlur={releaseDrag}
            onValueChange={handleValueChange}
            onValueCommit={handleCommit}
            min={fineRange.start}
            max={fineRange.end}
            step={1}
            className="w-full cursor-pointer"
          />
        </div>
      ) : null}
    </div>
  );
}