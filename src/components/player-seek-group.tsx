"use client";

import { useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { fineSeekWindow, formatPlayClock } from "@/lib/player/seek";
import type { ChapterTick } from "@/lib/player/chapter-nav";

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
  /** Top-level chapter starts. Hairlines on the main bar. */
  ticks?: ChapterTick[];
  /** Chapter name while a finger is on either bar. */
  chapterLabel?: string | null;
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
  ticks,
  chapterLabel,
}: PlayerSeekGroupProps) {
  /** Window frozen for the fine drag in progress, else null. */
  const [pinned, setPinned] = useState<{ start: number; end: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
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
   * pointercancel cover interrupted drags. No blur release: Radix moves
   * focus to the pressed thumb at the start of every drag, so the other
   * slider blurs mid-gesture and would wipe the state this drag just set.
   */
  const releaseDrag = () => {
    pointerHeld.current = false;
    setScrubbing(false);
    setPinned(null);
    onScrubActiveChange?.(false);
  };

  const holdPointer = () => {
    pointerHeld.current = true;
    setScrubbing(true);
  };

  const handleCommit = (value: number[]) => {
    releaseDrag();
    onScrubCommit(value[0] ?? 0);
  };

  const marks = (ticks ?? []).filter(
    (tick) => tick.startFraction > 0.004 && tick.startFraction < 0.996
  );
  const clock = formatPlayClock(currentTime);

  return (
    <div className="w-full space-y-2">
      <div className="relative">
        {scrubbing && chapterLabel ? (
          <p
            aria-hidden="true"
            className="pointer-events-none absolute bottom-full left-0 right-0 mb-1 truncate text-center font-serif text-sm text-muted-foreground"
          >
            {chapterLabel}
          </p>
        ) : null}
        {marks.length > 0 ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {marks.map((tick) => (
              <span
                key={`${tick.title}-${tick.startFraction}`}
                className="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/45"
                style={{ left: `${tick.startFraction * 100}%` }}
              />
            ))}
          </div>
        ) : null}
        <Slider
          aria-label="Seek"
          valueText={clock}
          value={[currentTime]}
          onPointerDown={() => {
            holdPointer();
            onFineReveal?.();
          }}
          onPointerUp={releaseDrag}
          onPointerCancel={releaseDrag}
          onLostPointerCapture={releaseDrag}
          onValueChange={handleValueChange}
          onValueCommit={handleCommit}
          min={0}
          max={duration || 1}
          step={0.1}
          disabled={disabled}
          className={`relative w-full ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
        />
      </div>
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
            valueText={clock}
            value={[
              Math.min(fineRange.end, Math.max(fineRange.start, currentTime)),
            ]}
            onPointerDown={() => {
              holdPointer();
              setPinned(fineRange);
            }}
            onPointerUp={releaseDrag}
            onPointerCancel={releaseDrag}
            onLostPointerCapture={releaseDrag}
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