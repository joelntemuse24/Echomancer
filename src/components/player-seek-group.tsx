"use client";

import { useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { fineSeekWindow, formatPlayClock, seekableDuration } from "@/lib/player/seek";
import type { ChapterTick } from "@/lib/player/chapter-nav";

interface PlayerSeekGroupProps {
  currentTime: number;
  duration: number;
  /** Stream mode: the bars stay visible but inert, and precise seek is off. */
  disabled?: boolean;
  /** Whether the precise (fine) slider is showing. Owned by the page or a pref. */
  fineVisible: boolean;
  /** Open or close the precise slider. Hides the disclosure when omitted. */
  onFineVisibleChange?: (visible: boolean) => void;
  /** Live scrub position (held drag or keyboard step). */
  onScrub: (seconds: number) => void;
  /** A finished seek. The page applies it to the audio element. */
  onScrubCommit: (seconds: number) => void;
  /** True while a pointer drag is held; the page freezes playhead updates for that window. */
  onScrubActiveChange?: (dragging: boolean) => void;
  /** Top-level chapter starts. Hairlines on the main bar. */
  ticks?: ChapterTick[];
  /** Chapter name while a finger is on either bar. */
  chapterLabel?: string | null;
}

/**
 * Seek bar, clocks, and the precise-seek window.
 *
 * The precise scrubber is a disclosure, closed unless the listener opens it
 * (`Precise seek`, a quiet chevron under the clocks). Its window follows the
 * playhead on a half-minute grid — a seek always lands inside, playback
 * slides it at most once a minute — and a held drag pins it so the thumb
 * cannot slip under the finger. The pin lifts on any drag end (commit,
 * stationary tap, or interrupted pointer), never on a timer. The main bar
 * is unchanged whether the window is open or shut.
 */
export function PlayerSeekGroup({
  currentTime,
  duration,
  disabled = false,
  fineVisible,
  onFineVisibleChange,
  onScrub,
  onScrubCommit,
  onScrubActiveChange,
  ticks,
  chapterLabel,
}: PlayerSeekGroupProps) {
  /** Window frozen for the precise drag in progress, else null. */
  const [pinned, setPinned] = useState<{ start: number; end: number } | null>(null);
  // Focus mode renders a second group behind the page, so the disclosure's
  // target id must be unique per instance.
  const panelId = useId();
  const [scrubbing, setScrubbing] = useState(false);
  const pointerHeld = useRef(false);

  const length = seekableDuration(duration, null);
  const fineRange = fineVisible && !disabled
    ? fineSeekWindow(currentTime, length, pinned)
    : null;

  const handleValueChange = (value: number[]) => {
    // Keyboard steps also fire this, after commit. Only a held pointer is a
    // drag, so an arrow key does not freeze the playhead.
    if (pointerHeld.current) onScrubActiveChange?.(true);
    onScrub(value[0] ?? 0);
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
          onPointerDown={holdPointer}
          onPointerUp={releaseDrag}
          onPointerCancel={releaseDrag}
          onLostPointerCapture={releaseDrag}
          onValueChange={handleValueChange}
          onValueCommit={handleCommit}
          min={0}
          max={length || 1}
          step={0.1}
          disabled={disabled}
          className={`relative w-full ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
        <span>{formatPlayClock(currentTime)}</span>
        <span>{disabled ? "—" : formatPlayClock(length)}</span>
      </div>
      {onFineVisibleChange && !disabled ? (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="precise-seek-toggle"
            aria-expanded={fineVisible}
            aria-controls={fineVisible ? panelId : undefined}
            onClick={() => onFineVisibleChange(!fineVisible)}
            className="tap inline-flex min-h-11 items-center gap-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            Precise seek
            <ChevronDown
              aria-hidden="true"
              strokeWidth={1.5}
              className={`h-3 w-3 transition-transform ${fineVisible ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      ) : null}
      {fineRange ? (
        <div id={panelId} className="space-y-1">
          <p className="text-center text-[11px] text-muted-foreground">
            {formatPlayClock(fineRange.start)}–{formatPlayClock(fineRange.end)}
          </p>
          <Slider
            aria-label="Precise seek"
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