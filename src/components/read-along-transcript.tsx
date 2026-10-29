"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  activeBlockIndex,
  charIndexForPlayback,
  sentenceSpans,
  type ReadAlongDocument,
  type ReadAlongPosition,
  type TranscriptBlock,
} from "@/lib/player/read-along";
import {
  FOLLOW_IDLE_RESUME_MS,
  WINDOW_EDGE_PX,
  extendWindow,
  followScrollDelta,
  initialWindow,
  tapCharIndex,
  windowCovering,
  type BlockWindow,
  type VerticalBox,
} from "@/lib/player/read-along-follow";
import {
  FOLLOW_PREF_KEY,
  boolPrefServerSnapshot,
  boolPrefSnapshot,
  setBoolPref,
  subscribePrefs,
} from "@/lib/player/read-along-prefs";
import { cn } from "@/lib/utils";

/** Caret offset into an element's text, or null when the browser has no hit test. */
function offsetInElement(el: HTMLElement, x: number, y: number): number | null {
  const doc = el.ownerDocument;
  const fromRange = doc.caretRangeFromPoint?.(x, y);
  if (fromRange && el.contains(fromRange.startContainer)) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.setEnd(fromRange.startContainer, fromRange.startOffset);
    return range.toString().length;
  }
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos && el.contains(pos.offsetNode)) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.setEnd(pos.offsetNode, pos.offset);
    return range.toString().length;
  }
  return null;
}

function box(rect: { top: number; height: number }): VerticalBox {
  return { top: rect.top, height: rect.height };
}

function scrollRootBy(root: HTMLElement, delta: number, smooth: boolean) {
  const max = Math.max(0, root.scrollHeight - root.clientHeight);
  const top = Math.min(max, Math.max(0, root.scrollTop + delta));
  if (typeof root.scrollTo === "function") {
    root.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  } else {
    root.scrollTop = top;
  }
}

/** Whether the reader asked the system for less movement. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

type BlockState = "past" | "current" | "upcoming";

const BLOCK_CLASS: Record<BlockState, string> = {
  past: "text-muted-foreground/55",
  upcoming: "text-foreground/90",
  current: "text-foreground",
};

const CHAPTER_BLOCK_CLASS: Record<BlockState, string> = {
  past: "text-muted-foreground/45",
  upcoming: "text-foreground/85",
  current: "text-foreground",
};

/**
 * One paragraph (or heading). Memoized on primitives: the 4 Hz timeupdate
 * only re-renders the passage whose state or sentence offset changed.
 */
const BlockRow = memo(function BlockRow({
  block,
  index,
  state,
  activeOffset,
  seekable,
  onSeekBlock,
}: {
  block: TranscriptBlock;
  index: number;
  state: BlockState;
  /** Readable offset of the playhead inside this block; only the active one has it. */
  activeOffset: number | null;
  seekable: boolean;
  onSeekBlock: (block: TranscriptBlock, localOffset: number | null) => void;
}) {
  const spans = useMemo(() => sentenceSpans(block.text), [block.text]);
  const sentence = useMemo(() => {
    if (activeOffset == null || spans.length === 0) return null;
    const at = Math.min(block.text.length - 1, Math.max(0, activeOffset));
    let found = spans[0]!;
    for (const span of spans) {
      if (at >= span.start) found = span;
      else break;
    }
    return found;
  }, [activeOffset, block.text.length, spans]);

  const seekHere = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!seekable) return;
      // Selecting text is not a seek. The click that ends a drag-selection
      // still carries the selection, so it is skipped too.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      const local = offsetInElement(event.currentTarget, event.clientX, event.clientY);
      onSeekBlock(block, local);
    },
    [block, onSeekBlock, seekable]
  );

  const control = seekable ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onSeekBlock(block, 0);
      }}
      aria-label={`Play from ${block.text.slice(0, 100)}`}
      className="ml-2 align-baseline font-sans text-[11px] text-muted-foreground underline decoration-foreground/30 underline-offset-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
    >
      Play from here
    </button>
  ) : null;

  if (block.kind === "chapter") {
    return (
      <h2
        data-block={index}
        data-state={state}
        onClick={seekHere}
        className={cn(
          "cursor-pointer font-serif tracking-tight transition-colors",
          block.level === 1 ? "pt-8 text-[1.75rem]" : "pt-5 text-[1.3rem]",
          index === 0 && "pt-0",
          CHAPTER_BLOCK_CLASS[state],
          state === "current" && "underline decoration-foreground/20 underline-offset-[0.3em]"
        )}
        style={{ fontWeight: 400 }}
      >
        {block.text}
        {control}
      </h2>
    );
  }

  return (
    <p
      data-block={index}
      data-state={state}
      onClick={seekHere}
      className={cn(
        "group cursor-pointer font-serif text-[1.0625rem] leading-[1.85] transition-colors duration-300",
        BLOCK_CLASS[state],
        state === "current" && "-mx-3 rounded-md bg-foreground/[0.05] px-3 py-1"
      )}
    >
      {sentence ? (
        <>
          {block.text.slice(0, sentence.start)}
          <span className="rounded-[3px] bg-foreground/[0.16] text-foreground [box-decoration-break:clone]">
            {block.text.slice(sentence.start, sentence.end)}
          </span>
          {block.text.slice(sentence.end)}
        </>
      ) : (
        block.text
      )}
      {control}
    </p>
  );
});

export function ReadAlongTranscript({
  document,
  position,
  onSeek,
  fullscreen = false,
  onToggleFullscreen,
}: {
  document: ReadAlongDocument;
  position: ReadAlongPosition;
  /** Passage seeking; stream text has no synchronized clock of its own. */
  onSeek?: (charIndex: number) => void;
  /** Rendered inside the focus overlay: fills its host instead of a panel. */
  fullscreen?: boolean;
  /** Provided when the reader can open or leave the focus overlay. */
  onToggleFullscreen?: () => void;
}) {
  const active = useMemo(
    () => activeBlockIndex(document, position),
    // Position is rebuilt every tick; depend on its fields, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      document,
      position.mode,
      position.currentTime,
      position.duration,
      position.sectionIndex,
      position.streamCursor,
    ]
  );
  const activeChar = useMemo(
    () => (active >= 0 ? charIndexForPlayback(document, position) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      active,
      document,
      position.mode,
      position.currentTime,
      position.duration,
      position.sectionIndex,
      position.streamCursor,
    ]
  );

  const total = document.blocks.length;
  const reducedMotion = usePrefersReducedMotion();
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The reader's remembered choice. Read through an external store so the
  // server render ("following") never disagrees with storage, and so a
  // deliberate pause written here survives a reload.
  const followPref = useSyncExternalStore(
    subscribePrefs,
    () => boolPrefSnapshot(FOLLOW_PREF_KEY, true),
    () => boolPrefServerSnapshot(true)
  );
  /** This visit paused following (a manual scroll or the header toggle). */
  const [paused, setPaused] = useState(false);
  const following = followPref && !paused;
  const [win, setWin] = useState<BlockWindow>(() => initialWindow(active, total));

  const activeRef = useRef(active);
  activeRef.current = active;
  const followingRef = useRef(following);
  followingRef.current = following;
  const totalRef = useRef(total);
  totalRef.current = total;
  const winRef = useRef(win);
  winRef.current = win;
  /** An idle pause (the reader scrolled) whose timer is running. */
  const idlePauseRef = useRef(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prependFixRef = useRef<number | null>(null);
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  const clearResumeTimer = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = null;
  }, []);

  // seek is rebuilt every player render; the ref keeps row props stable so
  // memoized rows skip the 4 Hz timeupdate renders.
  const onSeekBlock = useCallback(
    (block: TranscriptBlock, local: number | null) => {
      const seek = seekRef.current;
      if (!seek) return;
      seek(tapCharIndex(block, local));
      // The audio now plays from the tapped words, so the view follows the
      // playhead again.
      clearResumeTimer();
      idlePauseRef.current = false;
      setPaused(false);
      setBoolPref(FOLLOW_PREF_KEY, true);
    },
    [clearResumeTimer]
  );

  const resume = useCallback(() => {
    clearResumeTimer();
    idlePauseRef.current = false;
    setPaused(false);
    setBoolPref(FOLLOW_PREF_KEY, true);
  }, [clearResumeTimer]);

  /** A deliberate pause: stays paused until the listener resumes it. */
  const pause = useCallback(() => {
    clearResumeTimer();
    idlePauseRef.current = false;
    setPaused(true);
    setBoolPref(FOLLOW_PREF_KEY, false);
  }, [clearResumeTimer]);

  /** Wheel, touch drag, or keyboard scrolling: pause, and resume after 8 s of quiet. */
  const onManualScroll = useCallback(() => {
    if (followingRef.current) {
      idlePauseRef.current = true;
      setPaused(true);
    } else if (!idlePauseRef.current) {
      // Following was switched off on purpose; scrolling must not switch it on.
      return;
    }
    clearResumeTimer();
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      idlePauseRef.current = false;
      setPaused(false);
    }, FOLLOW_IDLE_RESUME_MS);
  }, [clearResumeTimer]);

  useEffect(() => () => clearResumeTimer(), [clearResumeTimer]);

  const chooseFollow = useCallback(
    (next: boolean) => {
      if (next) resume();
      else pause();
    },
    [pause, resume]
  );

  // A new document (a stream plan, a finished book) starts from the playhead.
  useEffect(() => {
    setWin(initialWindow(activeRef.current, totalRef.current));
  }, [document]);

  // Recentre the mounted slice around the playhead while following.
  useLayoutEffect(() => {
    if (!following || active < 0) return;
    setWin((prev) => windowCovering(prev, active, total));
  }, [active, following, total]);

  // Bring the active passage into the middle of the view.
  useLayoutEffect(() => {
    if (!following || active < 0) return;
    const root = scrollerRef.current;
    if (!root) return;
    let cancelled = false;
    let frames = 0;
    /**
     * Centre the active passage. Normal following drifts a passage at a time,
     * so it animates. A jump (chapter seek, resume, the focus overlay
     * opening) can be screens away, and animating that would crawl — it is
     * placed directly. A scroller that has just been inserted also reports no
     * height yet, so a pass that cannot measure retries on the next frame.
     */
    const place = (): "done" | "retry" => {
      const node = root.querySelector<HTMLElement>(`[data-block="${active}"]`);
      if (!node) return "retry";
      const view = box(root.getBoundingClientRect());
      if (!(view.height > 0)) return "retry";
      const delta = followScrollDelta(view, box(node.getBoundingClientRect()));
      if (delta == null) return "done";
      const smooth = !reducedMotion && Math.abs(delta) < view.height * 2;
      scrollRootBy(root, delta, smooth);
      return smooth ? "done" : "retry";
    };
    const settle = () => {
      if (cancelled) return;
      if (place() === "retry" && ++frames <= 6) requestAnimationFrame(settle);
    };
    settle();
    return () => {
      cancelled = true;
    };
  }, [active, following, total, win.start, win.end, reducedMotion]);

  // Prepending rows moves the text down; keep what the reader is reading still.
  useLayoutEffect(() => {
    const root = scrollerRef.current;
    const before = prependFixRef.current;
    if (!root || before == null) return;
    prependFixRef.current = null;
    root.scrollTop += root.scrollHeight - before;
  }, [win.start, win.end]);

  /** Grow the slice as a paused reader reaches an edge of the mounted text. */
  const onScroll = useCallback(() => {
    const root = scrollerRef.current;
    if (!root || followingRef.current) return;
    const atTop = root.scrollTop <= WINDOW_EDGE_PX;
    const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - WINDOW_EDGE_PX;
    if (!atTop && !atBottom) return;
    const current = winRef.current;
    const next = extendWindow(current, totalRef.current, atTop, atBottom);
    if (next === current) return;
    if (next.start < current.start) prependFixRef.current = root.scrollHeight;
    setWin(next);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        onManualScroll();
      }
    },
    [onManualScroll]
  );

  if (total === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">Transcript isn’t ready.</p>
    );
  }

  const synced = !(position.mode === "stream" && position.streamCursor == null);
  const showFollow = synced && active >= 0;
  const rows = document.blocks.slice(win.start, win.end);

  return (
    <div className={cn("flex min-h-0 flex-col", fullscreen && "h-full")}>
      <div className="mb-2 flex shrink-0 items-center justify-between gap-3 px-1">
        <button
          type="button"
          aria-pressed={following}
          aria-label={following ? "Following the audio" : "Follow is paused"}
          onClick={() => chooseFollow(!following)}
          className="inline-flex min-h-9 items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full transition-colors",
              following ? "bg-foreground/70" : "bg-foreground/25"
            )}
          />
          {following ? "Following" : "Paused"}
        </button>
        {onToggleFullscreen ? (
          <button
            type="button"
            onClick={onToggleFullscreen}
            aria-label={fullscreen ? "Exit focus mode" : "Focus mode"}
            className="inline-flex min-h-9 items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            {fullscreen ? (
              <Minimize2 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
            {fullscreen ? "Exit" : "Focus"}
          </button>
        ) : null}
      </div>

      {/* The scroller needs a bounded box or it grows with the text and
          `overflow-y: auto` never engages. Focus mode bounds it with the
          overlay's flex column; inline the max-height does that job. */}
      <div
        className={cn(
          "relative",
          fullscreen ? "flex min-h-0 flex-1 flex-col" : "shrink-0"
        )}
      >
        <div
          ref={scrollerRef}
          role="region"
          aria-label="Read along transcript"
          tabIndex={0}
          onScroll={onScroll}
          onWheel={onManualScroll}
          onTouchMove={onManualScroll}
          onKeyDown={onKeyDown}
          className={cn(
            "touch-pan-y overscroll-contain px-3 md:px-4",
            fullscreen
              ? "min-h-0 flex-1 overflow-y-auto pb-4"
              : "max-h-[min(70vh,40rem)] overflow-y-auto rounded-lg border border-foreground/10 py-4"
          )}
        >
          <div className="mx-auto max-w-[65ch] space-y-5">
            {rows.map((block, offset) => {
              const index = win.start + offset;
              const state: BlockState =
                active < 0 || index > active ? "upcoming" : index === active ? "current" : "past";
              return (
                <BlockRow
                  key={block.id}
                  block={block}
                  index={index}
                  state={state}
                  activeOffset={index === active ? activeChar - block.charStart : null}
                  seekable={Boolean(onSeek)}
                  onSeekBlock={onSeekBlock}
                />
              );
            })}
          </div>
        </div>

        {showFollow && !following ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <button
              type="button"
              onClick={() => chooseFollow(true)}
              className="pointer-events-auto inline-flex min-h-9 items-center rounded-full border border-foreground/15 bg-background/95 px-3.5 text-xs text-foreground shadow-sm backdrop-blur transition-colors hover:border-foreground/30"
            >
              Back to now
            </button>
          </div>
        ) : null}
      </div>

      {position.mode === "stream" && position.streamCursor == null ? (
        <p role="note" className="mt-2 shrink-0 text-center text-xs text-muted-foreground">
          Stream transcript is not synchronized with audio.
        </p>
      ) : null}
    </div>
  );
}
