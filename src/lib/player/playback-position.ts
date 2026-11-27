/**
 * Where a listener is in a book, as one clock for the whole file.
 *
 * A section MP3's `currentTime` starts at 0 for that part. The book clock
 * adds the earlier parts, so minute 33 stays minute 33 when the tab is
 * closed or the file is still arriving in pieces.
 */

import { playbackAllowed } from "@/lib/library/card-play";
import { bookmarkPlaceLabel } from "@/lib/player/bookmarks";
import { formatPlayClock } from "@/lib/player/seek";
import type { PrefStore } from "@/lib/player/player-prefs";

/** How often a playing book writes its position. */
export const RESUME_SAVE_INTERVAL_MS = 5000;

/**
 * A finished book this close to the end (or past it) opens at the start.
 * Ten seconds matches the player's skip.
 */
export const RESUME_END_MARGIN_SECONDS = 10;

/**
 * A position past the audio that exists so far lands just inside that end,
 * so the element does not treat the restore as "finished" and skip ahead.
 */
export const RESUME_EDGE_SECONDS = 0.25;

/** Positions under a second are the start of the book. */
export const RESUME_MIN_SECONDS = 1;

export type ResumeSaveReason = "tick" | "pause" | "seek" | "hide" | "track";

export type SectionSpan = {
  index: number;
  startSeconds: number;
  durationSeconds: number;
  /**
   * The part's playback URL, when the caller has it. The root-layout shell
   * needs this to change parts on its own after the player page unmounts;
   * the timing maths above ignores it.
   */
  url?: string;
};

export type StoredResume = {
  /** Book clock when `sectionIndex` is null. Otherwise the part's own clock. */
  positionSeconds: number;
  sectionIndex: number | null;
  /** Unix seconds. */
  updatedAt: number;
};

export type ResumeDecision =
  | { kind: "ignore" }
  | { kind: "start" }
  | { kind: "restart" }
  | { kind: "restore"; seconds: number };

type SpanSource = {
  index: number;
  status?: string | null;
  durationSeconds?: number | null;
};

/**
 * Ready parts from index 0 with no holes. A missing duration stops this
 * prefix. The player clock uses {@link sectionBookSpans}, which still
 * places a later ready part.
 */
export function contiguousSpans(rows: readonly SpanSource[]): SectionSpan[] {
  const byIndex = new Map<number, SpanSource>();
  for (const row of rows) {
    if (!Number.isInteger(row.index) || row.index < 0) continue;
    byIndex.set(row.index, row);
  }
  const spans: SectionSpan[] = [];
  let cursor = 0;
  for (let index = 0; ; index++) {
    const row = byIndex.get(index);
    if (!row) break;
    if (row.status != null && row.status !== "ready") break;
    const duration = row.durationSeconds;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) break;
    spans.push({ index, startSeconds: cursor, durationSeconds: duration });
    cursor += duration;
  }
  return spans;
}

/**
 * Book time for every ready part, including one that sits past a part that
 * is not ready yet. The missing part takes the average length of the parts
 * already measured, so the later file shows the book's clock. A ready part
 * with no measured length uses that same average.
 */
export function sectionBookSpans(rows: readonly SpanSource[]): SectionSpan[] {
  const byIndex = new Map<number, SpanSource>();
  for (const row of rows) {
    if (!Number.isInteger(row.index) || row.index < 0) continue;
    byIndex.set(row.index, row);
  }
  if (byIndex.size === 0) return [];
  const measured: number[] = [];
  for (const row of byIndex.values()) {
    const duration = row.durationSeconds;
    if (row.status != null && row.status !== "ready") continue;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      measured.push(duration);
    }
  }
  const estimate =
    measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) / measured.length : 0;
  const max = Math.max(...byIndex.keys());
  const spans: SectionSpan[] = [];
  let cursor = 0;
  for (let index = 0; index <= max; index += 1) {
    const row = byIndex.get(index);
    const known =
      row &&
      (row.status == null || row.status === "ready") &&
      typeof row.durationSeconds === "number" &&
      Number.isFinite(row.durationSeconds) &&
      row.durationSeconds > 0
        ? row.durationSeconds
        : null;
    const ready = row != null && (row.status == null || row.status === "ready");
    const width = known ?? estimate;
    if (ready && width > 0) {
      spans.push({ index, startSeconds: cursor, durationSeconds: known ?? estimate });
    }
    cursor += width > 0 ? width : 0;
  }
  return spans;
}

/**
 * Keep the start the listener already heard. A later measurement of a hole
 * must not move the part that is playing.
 */
export function withPinnedStart(
  spans: readonly SectionSpan[],
  pin: { index: number; start: number } | null
): SectionSpan[] {
  if (!pin || !Number.isFinite(pin.start)) return [...spans];
  return spans.map((span) =>
    span.index === pin.index ? { ...span, startSeconds: Math.max(0, pin.start) } : span
  );
}

/**
 * Local time on a section file. When the file ends, some engines report
 * `currentTime` 0; the length just played is the position to keep.
 */
export function sectionFileSeconds(input: {
  elementSeconds: number;
  elementDuration: number;
  ended: boolean;
}): number {
  const local = Number.isFinite(input.elementSeconds) ? Math.max(0, input.elementSeconds) : 0;
  const duration =
    Number.isFinite(input.elementDuration) && input.elementDuration > 0
      ? input.elementDuration
      : 0;
  if (input.ended && local < 0.5 && duration > 0.5) return duration;
  return local;
}

/**
 * Where an element's clock 0 sits on the book clock. A part file starts at
 * its part's offset; a finished book is 0. The shell uses it so a lock-screen
 * scrubber lands on the right minute of a book made of parts.
 */
export function elementClockOffset(
  spans: readonly SectionSpan[],
  sectionIndex: number | null
): number {
  if (sectionIndex == null) return 0;
  const span = spans.find((item) => item.index === sectionIndex);
  return span ? span.startSeconds : 0;
}

/** Seconds of audio a listener can reach right now. */
export function availableBookSeconds(
  spans: readonly SectionSpan[],
  fullDuration: number | null,
  complete: boolean
): number {
  if (complete && typeof fullDuration === "number" && fullDuration > 0) return fullDuration;
  if (spans.length === 0) return 0;
  const last = spans[spans.length - 1]!;
  return last.startSeconds + last.durationSeconds;
}

export function clampToAvailableEnd(position: number, availableSeconds: number): number {
  if (!(availableSeconds > 0)) return 0;
  const at = Number.isFinite(position) ? Math.max(0, position) : 0;
  if (at <= availableSeconds) return at;
  if (availableSeconds <= RESUME_EDGE_SECONDS) return 0;
  return availableSeconds - RESUME_EDGE_SECONDS;
}

/**
 * What to do with a stored position when the book is opened again.
 * A failed book is ignored. A finished book within {@link RESUME_END_MARGIN_SECONDS}
 * of the end starts over. A position past audio that is still generating
 * clamps to the available end.
 */
export function decideResume(input: {
  playbackAllowed: boolean;
  positionSeconds: number | null;
  durationSeconds: number | null;
  availableSeconds: number;
  complete: boolean;
}): ResumeDecision {
  if (!input.playbackAllowed) return { kind: "ignore" };
  const position = input.positionSeconds;
  if (position == null || !Number.isFinite(position) || position < RESUME_MIN_SECONDS) {
    return { kind: "start" };
  }
  const duration = input.durationSeconds;
  if (
    input.complete &&
    typeof duration === "number" &&
    duration > 0 &&
    position >= duration - RESUME_END_MARGIN_SECONDS
  ) {
    return { kind: "restart" };
  }
  const available =
    input.availableSeconds > 0
      ? input.availableSeconds
      : input.complete && typeof duration === "number" && duration > 0
        ? duration
        : 0;
  if (available > 0 && position > available) {
    return { kind: "restore", seconds: clampToAvailableEnd(position, available) };
  }
  return { kind: "restore", seconds: position };
}

/**
 * Element time → book clock. `absolute` is false when this part is not on
 * the contiguous clock yet; callers then keep the part index.
 */
export function bookTimeFromElement(input: {
  mode: "full" | "section" | "stream";
  elementSeconds: number;
  sectionIndex: number | null;
  spans: readonly SectionSpan[];
}): { seconds: number; absolute: boolean } {
  const local = Number.isFinite(input.elementSeconds) ? Math.max(0, input.elementSeconds) : 0;
  if (input.mode !== "section" || input.sectionIndex == null) {
    return { seconds: local, absolute: input.mode !== "stream" };
  }
  const span = input.spans.find((item) => item.index === input.sectionIndex);
  if (!span) return { seconds: local, absolute: false };
  const clipped = Math.min(span.durationSeconds, local);
  return { seconds: span.startSeconds + clipped, absolute: true };
}

/**
 * Book clock → the file that is actually playing. A full file uses the
 * book clock directly. A part file uses that part's own clock.
 */
export function placeOnTimeline(input: {
  bookSeconds: number;
  spans: readonly SectionSpan[];
}): { sectionIndex: number; localSeconds: number; bookSeconds: number } | null {
  if (input.spans.length === 0) return null;
  const seconds = Number.isFinite(input.bookSeconds) ? Math.max(0, input.bookSeconds) : 0;
  let chosen = input.spans[0]!;
  for (const span of input.spans) {
    if (seconds + 0.001 >= span.startSeconds) chosen = span;
    else break;
  }
  const end = chosen.startSeconds + chosen.durationSeconds;
  const inside = seconds < end - 0.001;
  const local = inside
    ? Math.max(0, seconds - chosen.startSeconds)
    : Math.max(0, chosen.durationSeconds - (chosen.durationSeconds > RESUME_EDGE_SECONDS ? RESUME_EDGE_SECONDS : 0));
  return {
    sectionIndex: chosen.index,
    localSeconds: local,
    bookSeconds: chosen.startSeconds + local,
  };
}

/**
 * The value worth storing. The end of a finished book is stored as 0 so
 * the next open, including another device, starts at the beginning.
 */
export function positionToPersist(input: {
  bookSeconds: number;
  durationSeconds: number | null;
  complete: boolean;
  ended: boolean;
}): { positionSeconds: number; finished: boolean } {
  const book = Number.isFinite(input.bookSeconds) ? Math.max(0, input.bookSeconds) : 0;
  const duration = input.durationSeconds;
  const nearEnd =
    input.complete &&
    typeof duration === "number" &&
    duration > 0 &&
    book >= duration - RESUME_END_MARGIN_SECONDS;
  if (input.ended || nearEnd) return { positionSeconds: 0, finished: true };
  return { positionSeconds: book, finished: false };
}

/** Tick writes are paced. Pause, seek, hide, and a part change write immediately. */
export function shouldPersistPlayhead(input: {
  reason: ResumeSaveReason;
  elapsedMs: number;
  gated: boolean;
}): boolean {
  if (input.gated && input.reason !== "seek" && input.reason !== "track") return false;
  if (input.reason === "tick") return input.elapsedMs >= RESUME_SAVE_INTERVAL_MS;
  return true;
}

/** The 5s write runs only while audio is playing and the tab is visible. */
export function resumeTickAllowed(input: { playing: boolean; hidden: boolean }): boolean {
  return input.playing && !input.hidden;
}

/**
 * A part is on the book clock when its start is known, including a ready
 * part after a hole. The file's own 0:00 is not the book.
 */
export function sectionOnBookClock(
  spans: readonly SectionSpan[],
  sectionIndex: number | null
): boolean {
  if (sectionIndex == null) return false;
  return spans.some((span) => span.index === sectionIndex);
}

/**
 * The job response moves the playhead onto the stored place.
 * An explicit seek wins. Pressing play before the row arrives does not.
 * `serverNewer` is a strictly newer row. That row is applied even while
 * audio is already playing. An equal or older row never rewinds a
 * playhead that has already passed the target.
 */
export function shouldApplyDetailSeek(input: {
  explicitSeek: boolean;
  playing: boolean;
  elementSeconds: number;
  targetSeconds: number;
  serverNewer: boolean;
}): boolean {
  if (input.explicitSeek) return false;
  if (!(input.targetSeconds > 0.05)) return false;
  const at = Number.isFinite(input.elementSeconds) ? input.elementSeconds : 0;
  if (Math.abs(at - input.targetSeconds) <= 0.25) return false;
  if (!input.serverNewer && at > input.targetSeconds + 0.25) return false;
  if (input.serverNewer) return true;
  if (input.playing) return false;
  return true;
}

/**
 * A pending seek that expired must not be replaced by the start of the file.
 * An explicit seek or part change may store. Playback may store once it has
 * moved forward from a position this tab already confirmed.
 */
export function mayPersistAfterDroppedSeek(input: {
  reason: ResumeSaveReason;
  elementSeconds: number;
  confirmedSeconds: number | null;
}): boolean {
  if (input.reason === "seek" || input.reason === "track") return true;
  const confirmed = input.confirmedSeconds;
  if (confirmed == null || !Number.isFinite(confirmed)) return false;
  const at = Number.isFinite(input.elementSeconds) ? input.elementSeconds : 0;
  return at >= confirmed + 0.5;
}

/** Skip a server write when the playhead has not moved. */
export function samePlayhead(
  previous: { positionSeconds: number; sectionIndex: number | null } | null,
  next: { positionSeconds: number; sectionIndex: number | null }
): boolean {
  if (!previous) return false;
  if (previous.sectionIndex !== next.sectionIndex) return false;
  return Math.abs(previous.positionSeconds - next.positionSeconds) < 0.5;
}

/**
 * What a pause, tick, or hide may store.
 * A source change resets `currentTime` to 0 and fires pause while
 * `readyState` is HAVE_NOTHING or a seek is still pending. That 0 is the
 * load, so it is not stored. A pending book time is stored instead.
 * Returns null when there is nothing safe to write.
 */
export function snapshotForPersist(input: {
  reason: ResumeSaveReason;
  currentTime: number;
  readyState: number;
  ended: boolean;
  pendingActive: boolean;
  pendingBookSeconds: number | null;
  restoreLanded: boolean;
  /** A pending target was dropped. The file start is not a substitute for it. */
  droppedSeek?: boolean;
  /** Element time this tab has already accepted. Progress is measured from here. */
  confirmedSeconds?: number | null;
  /** Book time last confirmed. A tick behind it is a reset, not a new position. */
  confirmedBookSeconds?: number | null;
  onSection: boolean;
  sectionIndex: number | null;
  spans: readonly SectionSpan[];
  complete: boolean;
  durationSeconds: number | null;
  hasNextSection: boolean;
}): { positionSeconds: number; sectionIndex: number | null } | null {
  const userAct = input.reason === "seek" || input.reason === "track";
  const loading = !(input.readyState > 0);
  const pendingTime =
    typeof input.pendingBookSeconds === "number" && Number.isFinite(input.pendingBookSeconds)
      ? Math.max(0, input.pendingBookSeconds)
      : null;

  const commit = (bookSeconds: number, absolute: boolean) => {
    const bookEnded =
      input.ended && input.complete && (!input.onSection || !input.hasNextSection);
    const stored = positionToPersist({
      bookSeconds,
      durationSeconds: input.durationSeconds,
      complete: input.complete,
      ended: bookEnded,
    });
    return {
      positionSeconds: stored.positionSeconds,
      sectionIndex: stored.finished || absolute ? null : input.sectionIndex,
    };
  };

  if (!userAct && (input.pendingActive || loading)) {
    if (pendingTime != null && pendingTime > 0.05) return commit(pendingTime, true);
    return null;
  }
  const element = Number.isFinite(input.currentTime) ? Math.max(0, input.currentTime) : 0;
  if (
    input.droppedSeek &&
    !mayPersistAfterDroppedSeek({
      reason: input.reason,
      elementSeconds: element,
      confirmedSeconds: input.confirmedSeconds ?? null,
    })
  ) {
    if (pendingTime != null && pendingTime > 0.05) return commit(pendingTime, true);
    return null;
  }
  if (!userAct && !input.restoreLanded && element < 0.5) {
    if (pendingTime != null && pendingTime > 0.05) return commit(pendingTime, true);
    return null;
  }
  const mapped = bookTimeFromElement({
    mode: input.onSection ? "section" : "full",
    elementSeconds: element,
    sectionIndex: input.onSection ? input.sectionIndex : null,
    spans: input.spans,
  });
  const confirmedBook = input.confirmedBookSeconds;
  if (
    !userAct &&
    typeof confirmedBook === "number" &&
    Number.isFinite(confirmedBook) &&
    mapped.seconds + 2 < confirmedBook
  ) {
    if (pendingTime != null && pendingTime > 0.05) return commit(pendingTime, true);
    return null;
  }
  return commit(mapped.seconds, mapped.absolute);
}

export function preferResume(
  local: StoredResume | null,
  remote: StoredResume | null
): StoredResume | null {
  if (!local) return remote;
  if (!remote) return local;
  return remote.updatedAt >= local.updatedAt ? remote : local;
}

export function resumeStorageKey(jobId: string): string {
  return `ec-resume:${jobId}`;
}

export function readStoredResume(store: PrefStore, jobId: string): StoredResume | null {
  if (!store) return null;
  try {
    const raw = store.getItem(resumeStorageKey(jobId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredResume>;
    if (typeof parsed.positionSeconds !== "number" || !Number.isFinite(parsed.positionSeconds)) {
      return null;
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) return null;
    const sectionIndex =
      typeof parsed.sectionIndex === "number" && Number.isInteger(parsed.sectionIndex)
        ? parsed.sectionIndex
        : null;
    return {
      positionSeconds: Math.max(0, parsed.positionSeconds),
      sectionIndex,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeStoredResume(store: PrefStore, jobId: string, value: StoredResume): void {
  if (!store) return;
  try {
    store.setItem(
      resumeStorageKey(jobId),
      JSON.stringify({
        positionSeconds: value.positionSeconds,
        sectionIndex: value.sectionIndex,
        updatedAt: value.updatedAt,
      })
    );
  } catch {
    // The in-memory copy still holds for this visit. The server write is separate.
  }
}

/**
 * Book clock for a stored mark. A legacy part-local row converts when that
 * part is on the contiguous clock. Otherwise null, and the part label stays.
 */
export function absoluteBookmarkSeconds(
  bookmark: { positionSeconds: number; sectionIndex: number | null },
  spans: readonly SectionSpan[]
): number | null {
  if (!Number.isFinite(bookmark.positionSeconds)) return null;
  if (bookmark.sectionIndex == null) return Math.max(0, bookmark.positionSeconds);
  const span = spans.find((item) => item.index === bookmark.sectionIndex);
  if (!span) return null;
  const local = Math.min(span.durationSeconds, Math.max(0, bookmark.positionSeconds));
  return span.startSeconds + local;
}

export function bookmarkClockLabel(
  bookmark: { positionSeconds: number; sectionIndex: number | null },
  spans: readonly SectionSpan[]
): string {
  const absolute = absoluteBookmarkSeconds(bookmark, spans);
  if (absolute == null) return bookmarkPlaceLabel(bookmark);
  return formatPlayClock(absolute);
}

/** One clock for dedupe. An unmapped legacy part keeps its own section. */
export function bookmarkOnAbsoluteClock(
  bookmark: { positionSeconds: number; sectionIndex: number | null },
  spans: readonly SectionSpan[]
): { positionSeconds: number; sectionIndex: number | null } {
  const absolute = absoluteBookmarkSeconds(bookmark, spans);
  if (absolute == null) {
    return {
      positionSeconds: bookmark.positionSeconds,
      sectionIndex: bookmark.sectionIndex,
    };
  }
  return { positionSeconds: absolute, sectionIndex: null };
}

export function sortBookmarksByClock<
  T extends { positionSeconds: number; sectionIndex: number | null },
>(rows: readonly T[], spans: readonly SectionSpan[]): T[] {
  const key = (row: T) => {
    const absolute = absoluteBookmarkSeconds(row, spans);
    if (absolute != null) return absolute;
    return (row.sectionIndex ?? 0) * 1_000_000 + Math.max(0, row.positionSeconds);
  };
  return [...rows].sort((a, b) => key(a) - key(b));
}

export type ResumeFields = {
  resume_position_seconds: number | null;
  resume_section_index: number | null;
  resume_updated_at: number | null;
};

export function resumeFields(
  row: { positionSeconds: number; sectionIndex: number | null; updatedAt: number } | null
): ResumeFields {
  if (!row) {
    return {
      resume_position_seconds: null,
      resume_section_index: null,
      resume_updated_at: null,
    };
  }
  return {
    resume_position_seconds: row.positionSeconds,
    resume_section_index: row.sectionIndex,
    resume_updated_at: row.updatedAt,
  };
}

/**
 * Library line. Empty when there is nothing to resume, the book must not
 * play, or the stored spot is the end of a finished book.
 */
export function libraryResumeLabel(input: {
  status: string | null | undefined;
  jobKind?: string | null;
  positionSeconds?: number | null;
  sectionIndex?: number | null;
  durationSeconds?: number | null;
  segments?: readonly SpanSource[] | null;
}): string | null {
  if (input.jobKind === "stream") return null;
  if (!playbackAllowed(input.status)) return null;
  if (typeof input.positionSeconds !== "number" || !Number.isFinite(input.positionSeconds)) {
    return null;
  }
  const spans = sectionBookSpans(input.segments ?? []);
  const complete = input.status === "ready";
  let position = input.positionSeconds;
  if (input.sectionIndex != null) {
    const absolute = absoluteBookmarkSeconds(
      { positionSeconds: input.positionSeconds, sectionIndex: input.sectionIndex },
      spans
    );
    if (absolute == null) return null;
    position = absolute;
  }
  const decision = decideResume({
    playbackAllowed: true,
    positionSeconds: position,
    durationSeconds: input.durationSeconds ?? null,
    availableSeconds: availableBookSeconds(spans, input.durationSeconds ?? null, complete),
    complete,
  });
  if (decision.kind !== "restore") return null;
  return `Resume at ${formatPlayClock(decision.seconds)}`;
}
