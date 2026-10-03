"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  CLIP_EDGE_PX,
  CLIP_HIT_PX,
  CLIP_TAP_PX,
  type ClipHit,
  type ClipSpan,
  applyClipDrag,
  clipEdgePanPx,
  clipPxToTime,
  clipScale,
  clipTimeToPx,
  clipTimelineEnd,
  hitClipSlider,
  moveClipEdgeBy,
  normalizeClipSpan,
  placeClipWindow,
} from "@/lib/youtube/clip-slider";
import { formatClock, MAX_CLIP_SEC, MIN_CLIP_SEC } from "@/lib/youtube/range";

type Drag = {
  pointerId: number;
  hit: ClipHit;
  originClientX: number;
  originScroll: number;
  origin: ClipSpan;
  lastClientX: number;
  pxPerSec: number;
  frame: number;
  movedPx: number;
  startedAt: number;
  detach: () => void;
};

function scrollMax(scroller: HTMLDivElement): number {
  return Math.max(0, scroller.scrollWidth - scroller.clientWidth);
}

/**
 * Pointer session for one press. Lives outside the component so the clock
 * and the animation frame are not part of render.
 */
function attachClipPointer(
  event: React.PointerEvent<HTMLDivElement>,
  scroller: HTMLDivElement | null,
  opts: {
    span: ClipSpan;
    pxPerSec: number;
    pad: number;
    duration: () => number;
    emit: (span: ClipSpan) => void;
    setActive: (edge: "start" | "end" | null) => void;
  }
): Drag | null {
  if (!scroller || event.button !== 0) return null;
  event.preventDefault();
  const rect = scroller.getBoundingClientRect();
  const x = event.clientX - rect.left + scroller.scrollLeft;
  const hit = hitClipSlider(x, opts.span, opts.pxPerSec, opts.pad);
  try {
    scroller.setPointerCapture(event.pointerId);
  } catch {
    /* Pointer capture is best-effort. Window listeners cover iOS. */
  }

  let frame = 0;
  let stopped = false;
  const drag: Drag = {
    pointerId: event.pointerId,
    hit,
    originClientX: event.clientX,
    originScroll: scroller.scrollLeft,
    origin: opts.span,
    lastClientX: event.clientX,
    pxPerSec: opts.pxPerSec,
    frame: 0,
    movedPx: 0,
    startedAt: performance.now(),
    detach: () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    },
  };

  let shown = opts.span;
  const applyHeld = (panPx: number) => {
    if (drag.hit === "track") return;
    const beforeScroll = scroller.scrollLeft;
    if (panPx !== 0) {
      scroller.scrollLeft = Math.min(scrollMax(scroller), Math.max(0, scroller.scrollLeft + panPx));
    }
    const deltaPx = drag.lastClientX - drag.originClientX + (scroller.scrollLeft - drag.originScroll);
    const next = applyClipDrag({
      hit: drag.hit,
      origin: drag.origin,
      deltaSec: deltaPx / drag.pxPerSec,
      durationSec: opts.duration(),
    });
    // A handle that has hit 10s, 40s, or the video end must not keep
    // scrolling the timeline out from under the finger.
    if (next.startSec === shown.startSec && next.endSec === shown.endSec) {
      scroller.scrollLeft = beforeScroll;
      return;
    }
    shown = next;
    opts.emit(next);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== drag.pointerId) return;
    ev.preventDefault();
    drag.movedPx = Math.max(drag.movedPx, Math.abs(ev.clientX - drag.originClientX));
    drag.lastClientX = ev.clientX;
    if (drag.hit === "track") {
      const dx = ev.clientX - drag.originClientX;
      scroller.scrollLeft = Math.min(scrollMax(scroller), Math.max(0, drag.originScroll - dx));
      return;
    }
    applyHeld(0);
  };

  const finish = (clientX: number | null) => {
    drag.detach();
    opts.setActive(null);
    if (drag.hit === "track" && clientX != null && drag.movedPx <= CLIP_TAP_PX) {
      const box = scroller.getBoundingClientRect();
      const time = clipPxToTime(clientX - box.left + drag.originScroll, drag.pxPerSec, opts.pad);
      const placed = placeClipWindow(time, drag.origin.endSec - drag.origin.startSec, opts.duration());
      if (placed) opts.emit(placed);
    }
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== drag.pointerId) return;
    finish(ev.type === "pointercancel" ? null : ev.clientX);
  };

  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  if (hit === "start" || hit === "end") opts.setActive(hit);
  else opts.setActive(null);

  if (hit !== "track") {
    let last = performance.now();
    const tick = (now: number) => {
      if (stopped) return;
      const dt = now - last;
      last = now;
      const box = scroller.getBoundingClientRect();
      const inEdge =
        drag.lastClientX < box.left + CLIP_EDGE_PX || drag.lastClientX > box.right - CLIP_EDGE_PX;
      const held = now - drag.startedAt > 220 || drag.movedPx > CLIP_TAP_PX;
      if (inEdge && held) applyHeld(clipEdgePanPx(drag.lastClientX, box.left, box.right, dt));
      frame = requestAnimationFrame(tick);
      drag.frame = frame;
    };
    frame = requestAnimationFrame(tick);
    drag.frame = frame;
  }
  return drag;
}

/**
 * One second earlier or later. A hold repeats. The first step is the click,
 * so a quick tap never counts twice.
 */
function FineStepButton({
  label,
  glyph,
  disabled,
  onStep,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onStep: () => void;
}) {
  const onStepRef = useRef(onStep);
  const holdRef = useRef<number | null>(null);
  const repeatRef = useRef<number | null>(null);
  const repeatedRef = useRef(0);

  useLayoutEffect(() => {
    onStepRef.current = onStep;
  }, [onStep]);

  const clear = () => {
    if (holdRef.current != null) window.clearTimeout(holdRef.current);
    if (repeatRef.current != null) window.clearInterval(repeatRef.current);
    holdRef.current = null;
    repeatRef.current = null;
  };

  useEffect(
    () => () => {
      if (holdRef.current != null) window.clearTimeout(holdRef.current);
      if (repeatRef.current != null) window.clearInterval(repeatRef.current);
    },
    []
  );

  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        repeatedRef.current = 0;
        clear();
        holdRef.current = window.setTimeout(() => {
          onStepRef.current();
          repeatedRef.current += 1;
          repeatRef.current = window.setInterval(() => {
            onStepRef.current();
            repeatedRef.current += 1;
          }, 140);
        }, 400);
      }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
      onClick={() => {
        if (disabled) return;
        if (repeatedRef.current > 0) {
          repeatedRef.current = 0;
          return;
        }
        onStep();
      }}
      style={{
        width: CLIP_HIT_PX,
        height: CLIP_HIT_PX,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: 0,
        borderRadius: 999,
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 22,
        lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.3 : 1,
        touchAction: "manipulation",
        WebkitTapHighlightColor: "transparent",
        userSelect: "none",
      }}
    >
      {glyph}
    </button>
  );
}

function FineEdge({
  clock,
  earlierLabel,
  laterLabel,
  canEarlier,
  canLater,
  onEarlier,
  onLater,
}: {
  clock: string;
  earlierLabel: string;
  laterLabel: string;
  canEarlier: boolean;
  canLater: boolean;
  onEarlier: () => void;
  onLater: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <FineStepButton label={earlierLabel} glyph="−" disabled={!canEarlier} onStep={onEarlier} />
      <span
        aria-hidden
          style={{
            minWidth: "3.4em",
            textAlign: "center",
            fontSize: 12,
            lineHeight: "16px",
            opacity: 0.75,
            fontVariantNumeric: "tabular-nums",
            userSelect: "none",
          }}
      >
        {clock}
      </span>
      <FineStepButton label={laterLabel} glyph="+" disabled={!canLater} onStep={onLater} />
    </div>
  );
}

/**
 * Start and end of a 10–40s sample. Handles stay apart on a long video
 * because the timeline scrolls instead of shrinking onto the row.
 * Fine tune stays under the timeline and steps one edge by one second.
 */
export function ClipRangeSlider({
  startSec,
  endSec,
  durationSec,
  disabled,
  resetKey,
  onChange,
}: {
  startSec: number;
  endSec: number;
  durationSec: number;
  disabled?: boolean;
  /** New video. The timeline recenters on the sample. */
  resetKey: string;
  onChange: (span: ClipSpan) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const spanRef = useRef({ startSec, endSec });
  const onChangeRef = useRef(onChange);
  const durationRef = useRef(durationSec);
  const [viewportPx, setViewportPx] = useState(0);
  const fineId = useId();

  useLayoutEffect(() => {
    spanRef.current = { startSec, endSec };
    durationRef.current = durationSec;
    onChangeRef.current = onChange;
  }, [startSec, endSec, durationSec, onChange]);
  const [active, setActive] = useState<"start" | "end" | null>(null);
  const scale = clipScale(durationSec, viewportPx);
  const endCap = clipTimelineEnd(durationSec);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let centered = false;
    const center = () => {
      const width = scroller.clientWidth;
      if (width <= 0) return;
      setViewportPx(width);
      if (centered) return;
      const next = clipScale(durationRef.current, width);
      const span = spanRef.current;
      const mid = clipTimeToPx((span.startSec + span.endSec) / 2, next.pxPerSec, next.pad);
      scroller.scrollLeft = Math.max(0, mid - width / 2);
      centered = true;
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [resetKey]);

  useEffect(() => {
    return () => {
      dragRef.current?.detach();
      dragRef.current = null;
    };
  }, []);

  const emit = (next: ClipSpan) => {
    const current = spanRef.current;
    if (next.startSec === current.startSec && next.endSec === current.endSec) return;
    onChangeRef.current(next);
  };

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    dragRef.current?.detach();
    const next = attachClipPointer(event, scrollerRef.current, {
      span: spanRef.current,
      pxPerSec: scale.pxPerSec,
      pad: scale.pad,
      duration: () => durationRef.current,
      emit,
      setActive,
    });
    dragRef.current = next;
  };

  const nudge = (edge: "start" | "end", delta: number) => {
    if (disabled) return;
    emit(moveClipEdgeBy(spanRef.current, edge, delta, durationRef.current));
  };

  const onKey = (edge: "start" | "end") => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 5 : 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      nudge(edge, -step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      nudge(edge, step);
    } else if (event.key === "Home") {
      event.preventDefault();
      nudge(edge, edge === "start" ? -endCap : -MAX_CLIP_SEC);
    } else if (event.key === "End") {
      event.preventDefault();
      nudge(edge, edge === "start" ? MAX_CLIP_SEC : endCap);
    }
  };

  const legal = normalizeClipSpan(startSec, endSec, durationSec);
  const canMove = (edge: "start" | "end", delta: number) => {
    if (!legal || disabled) return false;
    const next = moveClipEdgeBy(legal, edge, delta, durationSec);
    return next.startSec !== legal.startSec || next.endSec !== legal.endSec;
  };
  const startX = clipTimeToPx(startSec, scale.pxPerSec, scale.pad);
  const endX = clipTimeToPx(endSec, scale.pxPerSec, scale.pad);
  const thumb = (edge: "start" | "end", x: number) => (
    <button
      type="button"
      role="slider"
      aria-label={edge === "start" ? "Start" : "End"}
      aria-orientation="horizontal"
      aria-valuemin={edge === "start" ? 0 : startSec + MIN_CLIP_SEC}
      aria-valuemax={
        edge === "start" ? Math.max(0, endSec - MIN_CLIP_SEC) : Math.min(endCap, startSec + MAX_CLIP_SEC)
      }
      aria-valuenow={edge === "start" ? startSec : endSec}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKey(edge)}
      style={{
        position: "absolute",
        left: x,
        top: "50%",
        width: CLIP_HIT_PX,
        height: CLIP_HIT_PX,
        transform: "translate(-50%, -50%)",
        padding: 0,
        border: 0,
        borderRadius: 999,
        background: "transparent",
        color: "inherit",
        touchAction: "none",
        zIndex: active === edge ? 3 : 2,
        cursor: disabled ? "default" : "grab",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 20,
          height: 20,
          transform: "translate(-50%, -50%)",
          borderRadius: 999,
          background: "currentColor",
        }}
      />
    </button>
  );

  return (
    <div style={{ width: "100%" }}>
    <div
      ref={scrollerRef}
      onPointerDownCapture={begin}
      aria-hidden={false}
      style={{
        position: "relative",
        width: "100%",
        minHeight: CLIP_HIT_PX,
        overflowX: "auto",
        overflowY: "hidden",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        overscrollBehavior: "none",
        scrollbarWidth: "none",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "grab",
      }}
    >
      <div style={{ position: "relative", width: scale.width, height: CLIP_HIT_PX, touchAction: "none" }}>
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: scale.pad,
            width: Math.max(0, scale.width - scale.pad * 2),
            top: "50%",
            height: 2,
            transform: "translateY(-50%)",
            borderRadius: 999,
            background: "currentColor",
            opacity: 0.2,
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: startX,
            width: Math.max(0, endX - startX),
            top: "50%",
            height: 2,
            transform: "translateY(-50%)",
            background: "currentColor",
          }}
        />
        {thumb("start", startX)}
        {thumb("end", endX)}
      </div>
    </div>
    {legal ? (
      <div style={{ marginTop: 4 }}>
        <p
          id={fineId}
          style={{
            margin: 0,
            textAlign: "center",
            fontSize: 11,
            lineHeight: "16px",
            opacity: 0.6,
          }}
        >
          Fine tune
        </p>
        <div
          role="group"
          aria-labelledby={fineId}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
          }}
        >
          <FineEdge
            clock={formatClock(legal.startSec)}
            earlierLabel="Start earlier"
            laterLabel="Start later"
            canEarlier={canMove("start", -1)}
            canLater={canMove("start", 1)}
            onEarlier={() => nudge("start", -1)}
            onLater={() => nudge("start", 1)}
          />
          <FineEdge
            clock={formatClock(legal.endSec)}
            earlierLabel="End earlier"
            laterLabel="End later"
            canEarlier={canMove("end", -1)}
            canLater={canMove("end", 1)}
            onEarlier={() => nudge("end", -1)}
            onLater={() => nudge("end", 1)}
          />
        </div>
      </div>
    ) : null}
    </div>
  );
}
