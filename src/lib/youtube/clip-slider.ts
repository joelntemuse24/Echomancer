/**
 * Two-handle YouTube sample window.
 * Client-safe. The picker, the label, and POST /api/clips share these seconds.
 *
 * A 10–40s clip on a long video is a few pixels on a full-length track, so the
 * two handles stack and the top one steals every drag. This track never
 * squeezes below 8px per second. Dragging a handle moves only that edge and
 * stops at 10s and 40s. Dragging the span moves the window and keeps the length.
 * Fine tune steps one edge by one second with those same stops. On a long
 * source it stays open. Nothing here hides it on blur or a timer.
 */

import { CLIP_LONG_SOURCE_SEC } from "@/lib/youtube/clip-policy";
import { MAX_CLIP_SEC, MIN_CLIP_SEC } from "@/lib/youtube/range";

/** Minimum seconds between handle centers. 10s × this stays wider than a thumb. */
export const CLIP_PX_PER_SEC = 8;
/** Phone-sized thumb. Handles closer than this cannot be grabbed apart. */
export const CLIP_HIT_PX = 44;
/** Inset so a handle at 0:00 is not clipped by the scroller. */
export const CLIP_PAD_PX = CLIP_HIT_PX / 2;
/** Movement smaller than this, on empty timeline, places the window. */
export const CLIP_TAP_PX = 6;
/** Pointer in this zone pans the timeline and keeps moving the held edge. */
export const CLIP_EDGE_PX = 32;

export type ClipSpan = { startSec: number; endSec: number };
export type ClipHit = "start" | "end" | "window" | "track";

/** A source this long keeps Fine tune visible without a first touch. */
export function clipFineTunePinned(durationSec: number): boolean {
  return Number.isFinite(durationSec) && durationSec >= CLIP_LONG_SOURCE_SEC;
}

/** Latest whole second still inside the video, including the API's 0.05s slack. */
export function clipTimelineEnd(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.max(0, Math.floor(durationSec + 0.05));
}

export function clipScale(
  durationSec: number,
  viewportPx: number
): { pxPerSec: number; pad: number; width: number } {
  const end = clipTimelineEnd(durationSec);
  const pad = CLIP_PAD_PX;
  const natural = pad * 2 + end * CLIP_PX_PER_SEC;
  if (end <= 0) return { pxPerSec: CLIP_PX_PER_SEC, pad, width: Math.max(natural, viewportPx) };
  // A short video can spread out. A long one must not squeeze the handles together.
  if (viewportPx > natural) {
    const pxPerSec = (viewportPx - pad * 2) / end;
    return { pxPerSec, pad, width: viewportPx };
  }
  return { pxPerSec: CLIP_PX_PER_SEC, pad, width: natural };
}

export function clipTimeToPx(timeSec: number, pxPerSec = CLIP_PX_PER_SEC, pad = CLIP_PAD_PX): number {
  return pad + timeSec * pxPerSec;
}

export function clipPxToTime(px: number, pxPerSec = CLIP_PX_PER_SEC, pad = CLIP_PAD_PX): number {
  if (pxPerSec <= 0) return 0;
  return (px - pad) / pxPerSec;
}

/**
 * Whole-second window inside the video. Null when the video is under 10s.
 * Length is kept; the window slides inward rather than running past the end.
 */
export function normalizeClipSpan(
  startSec: number,
  endSec: number,
  durationSec: number
): ClipSpan | null {
  const endCap = clipTimelineEnd(durationSec);
  if (endCap < MIN_CLIP_SEC) return null;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
  let length = Math.round(endSec) - Math.round(startSec);
  if (!Number.isFinite(length) || length <= 0) length = Math.min(MAX_CLIP_SEC, endCap);
  length = Math.min(MAX_CLIP_SEC, Math.max(MIN_CLIP_SEC, length), endCap);
  let start = Math.round((startSec + endSec) / 2 - length / 2);
  if (start < 0) start = 0;
  if (start + length > endCap) start = endCap - length;
  if (start < 0) return null;
  return { startSec: start, endSec: start + length };
}

/** Move both edges by the same amount. Length stays. Stops at the video ends. */
export function moveClipWindow(span: ClipSpan, deltaSec: number, durationSec: number): ClipSpan {
  const normalized = normalizeClipSpan(span.startSec, span.endSec, durationSec);
  if (!normalized) return span;
  const length = normalized.endSec - normalized.startSec;
  const endCap = clipTimelineEnd(durationSec);
  let start = Math.round(normalized.startSec + deltaSec);
  if (start < 0) start = 0;
  if (start + length > endCap) start = Math.max(0, endCap - length);
  return { startSec: start, endSec: start + length };
}

/**
 * Move one edge. The other edge stays where it is. At 10s or 40s this edge
 * stops — it does not push the other one along, and the two never cross.
 */
export function resizeClipEdge(
  span: ClipSpan,
  edge: "start" | "end",
  timeSec: number,
  durationSec: number
): ClipSpan {
  const current = normalizeClipSpan(span.startSec, span.endSec, durationSec);
  if (!current) return span;
  const endCap = clipTimelineEnd(durationSec);
  if (edge === "start") {
    let start = Math.round(timeSec);
    const minStart = current.endSec - MAX_CLIP_SEC;
    const maxStart = current.endSec - MIN_CLIP_SEC;
    if (start < minStart) start = minStart;
    if (start > maxStart) start = maxStart;
    if (start < 0) start = 0;
    if (current.endSec - start > MAX_CLIP_SEC) start = current.endSec - MAX_CLIP_SEC;
    if (current.endSec - start < MIN_CLIP_SEC) start = current.endSec - MIN_CLIP_SEC;
    if (start < 0 || start >= current.endSec) return current;
    return { startSec: start, endSec: current.endSec };
  }
  let end = Math.round(timeSec);
  const minEnd = current.startSec + MIN_CLIP_SEC;
  const maxEnd = Math.min(endCap, current.startSec + MAX_CLIP_SEC);
  if (end < minEnd) end = minEnd;
  if (end > maxEnd) end = maxEnd;
  if (end - current.startSec < MIN_CLIP_SEC || end > endCap) return current;
  return { startSec: current.startSec, endSec: end };
}

/**
 * Move one edge by whole seconds. The other edge stays. At 10s, 40s, or the
 * video, the span comes back unchanged.
 */
export function moveClipEdgeBy(
  span: ClipSpan,
  edge: "start" | "end",
  deltaSec: number,
  durationSec: number
): ClipSpan {
  const current = normalizeClipSpan(span.startSec, span.endSec, durationSec);
  if (!current) return span;
  const delta = Math.round(deltaSec);
  if (delta === 0) return current;
  const time = (edge === "start" ? current.startSec : current.endSec) + delta;
  return resizeClipEdge(current, edge, time, durationSec);
}

/**
 * Which gesture a pointer starts. `xPx` is in timeline content pixels.
 * When the handles are closer than a thumb, the press moves the window:
 * the top handle must not trap the drag on one edge.
 */
export function hitClipSlider(
  xPx: number,
  span: ClipSpan,
  pxPerSec = CLIP_PX_PER_SEC,
  pad = CLIP_PAD_PX
): ClipHit {
  const startX = clipTimeToPx(span.startSec, pxPerSec, pad);
  const endX = clipTimeToPx(span.endSec, pxPerSec, pad);
  const half = CLIP_HIT_PX / 2;
  const left = Math.min(startX, endX);
  const right = Math.max(startX, endX);
  if (right - left < CLIP_HIT_PX) {
    if (xPx >= left - half && xPx <= right + half) return "window";
    return "track";
  }
  const startDist = Math.abs(xPx - startX);
  const endDist = Math.abs(xPx - endX);
  const onStart = startDist <= half;
  const onEnd = endDist <= half;
  if (onStart && onEnd) return startDist <= endDist ? "start" : "end";
  if (onStart) return "start";
  if (onEnd) return "end";
  if (xPx > left && xPx < right) return "window";
  return "track";
}

/** Place the window so `timeSec` is its midpoint, keeping the length. */
export function placeClipWindow(
  timeSec: number,
  lengthSec: number,
  durationSec: number
): ClipSpan | null {
  const endCap = clipTimelineEnd(durationSec);
  const length = Math.min(MAX_CLIP_SEC, Math.max(MIN_CLIP_SEC, Math.round(lengthSec)), endCap);
  if (endCap < length) return null;
  return moveClipWindow({ startSec: 0, endSec: length }, timeSec - length / 2, durationSec);
}

/**
 * One drag step measured from the pointer-down window, not from the last
 * frame. A fast move past the other edge cannot swap which edge is held.
 */
export function applyClipDrag(opts: {
  hit: Exclude<ClipHit, "track">;
  origin: ClipSpan;
  deltaSec: number;
  durationSec: number;
}): ClipSpan {
  if (opts.hit === "window") return moveClipWindow(opts.origin, opts.deltaSec, opts.durationSec);
  const time =
    opts.hit === "start" ? opts.origin.startSec + opts.deltaSec : opts.origin.endSec + opts.deltaSec;
  return resizeClipEdge(opts.origin, opts.hit, time, opts.durationSec);
}

/**
 * Whole seconds for POST /api/clips. The old picker rounded the length up
 * and could send start + length past the video (`range_unsupported`).
 */
export function clipRequestWindow(
  startSec: number,
  endSec: number,
  durationSec?: number
): { startSeconds: number; lengthSeconds: number } | null {
  const duration =
    durationSec != null && Number.isFinite(durationSec) ? durationSec : Math.max(startSec, endSec);
  const span = normalizeClipSpan(startSec, endSec, duration);
  if (!span) return null;
  const lengthSeconds = span.endSec - span.startSec;
  if (span.startSec + lengthSeconds > duration + 0.05) return null;
  return { startSeconds: span.startSec, lengthSeconds };
}

/** Pixels to add to scrollLeft this frame while the pointer sits in an edge zone. */
export function clipEdgePanPx(
  pointerX: number,
  left: number,
  right: number,
  dtMs: number
): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0 || right <= left) return 0;
  const edge = CLIP_EDGE_PX;
  let sign = 0;
  let depth = 0;
  if (pointerX < left + edge) {
    sign = -1;
    depth = (left + edge - pointerX) / edge;
  } else if (pointerX > right - edge) {
    sign = 1;
    depth = (pointerX - (right - edge)) / edge;
  } else {
    return 0;
  }
  depth = Math.min(1, Math.max(0, depth));
  const pxPerSec = 80 + depth * depth * 6000;
  return sign * pxPerSec * (Math.min(dtMs, 64) / 1000);
}
