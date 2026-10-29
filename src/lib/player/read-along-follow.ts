/**
 * Auto-follow for the read-along panel: when the highlight may move the
 * view, when a manual scroll pauses it, and where a tap inside a paragraph
 * lands on the playback clock.
 *
 * Everything here is arithmetic over plain values so the behaviour the
 * listener feels — pause on a manual scroll, resume after the idle window,
 * keep the active passage in view, seek to the tapped word — is verifiable
 * without a browser.
 */

/** A manual scroll pauses following for this long before it resumes itself. */
export const FOLLOW_IDLE_RESUME_MS = 8_000;

/**
 * Following state. `lastInteractionAt` is a `performance.now()` clock reading
 * for the most recent manual scroll, so repeated scrolling pushes the idle
 * window back without re-rendering anything. A null reading is a pause with
 * no timer: the reader turned following off, and it stays off.
 */
export interface FollowState {
  following: boolean;
  lastInteractionAt: number | null;
}

export const FOLLOWING: FollowState = Object.freeze({
  following: true,
  lastInteractionAt: null,
});

export const NOT_FOLLOWING: FollowState = Object.freeze({
  following: false,
  lastInteractionAt: null,
});

/** Following stopped: the reader scrolled at `at`, or `null` for "stay paused". */
export function pauseFollow(at: number | null = null): FollowState {
  return { following: false, lastInteractionAt: at };
}

/** The reader asked for the playhead again. */
export function resumeFollow(): FollowState {
  return FOLLOWING;
}

/**
 * Milliseconds until an idle pause ends. Infinite for a pause the reader set
 * deliberately (no scroll clock), 0 once the idle window has already passed.
 */
export function idleRemainingMs(
  state: FollowState,
  now: number,
  idleMs = FOLLOW_IDLE_RESUME_MS
): number {
  if (state.following) return 0;
  if (state.lastInteractionAt == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, idleMs - (now - state.lastInteractionAt));
}

/** Whether an idle pause has run out, so following should restart. */
export function shouldAutoResume(
  state: FollowState,
  now: number,
  idleMs = FOLLOW_IDLE_RESUME_MS
): boolean {
  if (state.following || state.lastInteractionAt == null) return false;
  return now - state.lastInteractionAt >= idleMs;
}

/** Start of the word a pointer landed in (or the next one, in a gap). */
export function wordStartInText(text: string, offset: number): number {
  if (text.length === 0) return 0;
  const at = Math.min(text.length - 1, Math.max(0, Math.floor(offset)));
  let index = at;
  if (/\s/.test(text[index]!)) {
    // A tap in a gap belongs to the next word; a tap past the last word
    // belongs to the last one.
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
    if (index >= text.length) {
      index = at;
      while (index > 0 && /\s/.test(text[index]!)) index -= 1;
    }
  }
  while (index > 0 && !/\s/.test(text[index - 1]!)) index -= 1;
  return index;
}

/**
 * Readable-text index for a tap: the block's own start when the pointer
 * position is unknown (no caret API), otherwise the tapped word. Word
 * precision is what keeps a tap inside a second of the words under the
 * finger — a whole sentence can be several seconds long.
 */
export function tapCharIndex(
  block: { charStart: number; text: string },
  localOffset: number | null
): number {
  if (localOffset == null) return block.charStart;
  return block.charStart + wordStartInText(block.text, localOffset);
}

/** A box in viewport coordinates: the scroller's window, or a paragraph. */
export interface VerticalBox {
  top: number;
  height: number;
}

/** Fraction of the window the active passage may occupy without a scroll. */
export interface FollowBand {
  head: number;
  foot: number;
}

export const FOLLOW_BAND: FollowBand = { head: 0.25, foot: 0.75 };

/** Pixels to scroll so the block sits in the middle of the window. */
export function centerScrollDelta(view: VerticalBox, block: VerticalBox): number {
  const delta = block.top - view.top + block.height / 2 - view.height / 2;
  return Math.round(delta);
}

/**
 * Pixels to scroll so the active passage is comfortably visible, or null
 * when it already is. Inside the band nothing moves, so a paragraph that
 * stays highlighted does not drag the page around; outside it the block
 * comes back to the middle, which is where the reader is looking.
 */
export function followScrollDelta(
  view: VerticalBox,
  block: VerticalBox,
  band: FollowBand = FOLLOW_BAND
): number | null {
  if (!(view.height > 0)) return null;
  const relativeTop = block.top - view.top;
  const relativeBottom = relativeTop + block.height;
  const head = view.height * band.head;
  const foot = view.height * band.foot;
  if (block.height >= view.height * 0.9) {
    // A passage taller than the window cannot fit. Its head is what the
    // reader follows, so leave it alone while the head is on screen and
    // bring it back into the band once it has gone off the top or sits
    // below the fold.
    if (relativeTop < 0 || relativeTop > foot) {
      return Math.round(relativeTop - head);
    }
    return null;
  }
  if (relativeTop >= head && relativeBottom <= foot) return null;
  return centerScrollDelta(view, block);
}

/* ------------------------------------------------------------------ */
/* Render window                                                       */
/* ------------------------------------------------------------------ */

/**
 * Only a slice of a long book is mounted. The window keeps a couple of
 * screens of context above the playhead and a good deal below it, so
 * following never hits the end of the mounted text while the reader browses
 * a little ahead of the narration.
 */
export const WINDOW_BEHIND = 40;
export const WINDOW_AHEAD = 160;
/** Rows added when a manual scroll reaches an edge of the mounted slice. */
export const WINDOW_EXTEND = 60;
/** Distance from an edge, in pixels, that extends the slice. */
export const WINDOW_EDGE_PX = 480;

export interface BlockWindow {
  start: number;
  end: number;
}

export function initialWindow(active: number, total: number): BlockWindow {
  const at = Math.max(0, Math.min(Math.max(0, total - 1), active));
  return {
    start: Math.max(0, at - WINDOW_BEHIND),
    end: Math.min(total, at + WINDOW_AHEAD),
  };
}

/**
 * The window that covers the active passage.
 *
 * Following normally advances the playhead one passage at a time, so
 * appending keeps the mounted rows above it and the reader's scroll position
 * does not move. A playhead that lands outside the mounted slice — a chapter
 * seek, a scrub, a resume from a pause — gets a fresh window centred on
 * itself instead, so the mount stays bounded.
 */
export function windowCovering(
  current: BlockWindow,
  active: number,
  total: number
): BlockWindow {
  if (active < 0 || total <= 0) return current;
  if (active < current.start + 10 || active >= current.end) {
    return initialWindow(active, total);
  }
  if (active >= current.end - 20) {
    return {
      start: current.start,
      end: Math.min(total, Math.max(current.end, active + WINDOW_AHEAD)),
    };
  }
  return current;
}

/**
 * The new window after a manual scroll: extend toward the edge the reader
 * is heading for. `atTop` prepends, `atBottom` appends. Prepending needs the
 * caller to keep the visible text still.
 */
export function extendWindow(
  current: BlockWindow,
  total: number,
  atTop: boolean,
  atBottom: boolean
): BlockWindow {
  let { start, end } = current;
  if (atTop && start > 0) start = Math.max(0, start - WINDOW_EXTEND);
  if (atBottom && end < total) end = Math.min(total, end + WINDOW_EXTEND);
  if (start === current.start && end === current.end) return current;
  return { start, end };
}
