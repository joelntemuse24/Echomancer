/**
 * Chapter navigation for the player.
 *
 * A stored list is either flat (one row per chapter) or nested. Nesting is
 * an optional `children` array of the same shape, or `level: 2` (and deeper)
 * rows that follow their parent. Flat lists stay flat. Fewer than two places
 * to skip — a book with no chapters, or a single chapter — is not navigable.
 */

import { formatPlayClock } from "@/lib/player/seek";

/** Previous restarts the current chapter when the playhead is further in than this. */
export const CHAPTER_RESTART_SECONDS = 3;

const MAX_DEPTH = 6;

export interface PlayerChapter {
  index?: number;
  title: string;
  subtitle?: string;
  startFraction: number;
  startSeconds?: number;
  endSeconds?: number;
  /** 1 is a part. 2 and deeper follow the previous shallower row. */
  level?: number;
  children?: PlayerChapter[];
}

export interface ChapterNode {
  id: string;
  title: string;
  subtitle?: string;
  startFraction: number;
  startSeconds?: number;
  endSeconds?: number;
  children: ChapterNode[];
}

export interface ChapterTick {
  startFraction: number;
  title: string;
}

export interface ChapterRow {
  id: string;
  node: ChapterNode;
  title: string;
  subtitle?: string;
  start: number;
  length: number;
  /** Screen-reader name for the row. */
  label: string;
  depth: number;
  children: ChapterRow[];
}

export interface ChapterView {
  /** Two or more skip points. Books with 0–1 show none of the chapter UI. */
  enabled: boolean;
  rows: ChapterRow[];
  /** Top-level chapter starts only. Sub-chapters do not mark the scrubber. */
  ticks: ChapterTick[];
  /** Quiet line under the title. Null when chapter navigation is off. */
  line: string | null;
  /** Name shown on the scrubber while it is dragged. */
  dragLabel: string | null;
  activeId: string | null;
  activePartId: string | null;
  previous: ChapterNode | null;
  next: ChapterNode | null;
}

interface Timed {
  node: ChapterNode;
  start: number;
  end: number;
  children: Timed[];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Keep the fields the player understands. Drops untitled rows. */
export function sanitizePlaybackChapters(input: unknown): PlayerChapter[] {
  if (!Array.isArray(input)) return [];
  let count = 0;
  const one = (row: unknown, depth: number): PlayerChapter | null => {
    if (!row || typeof row !== "object" || count >= 2000) return null;
    const chapter = row as Record<string, unknown>;
    const title = clean(chapter.title);
    if (!title) return null;
    count += 1;
    const subtitle = clean(chapter.subtitle);
    const startFractionRaw = finiteNumber(chapter.startFraction);
    const startSeconds = finiteNumber(chapter.startSeconds);
    const endSeconds = finiteNumber(chapter.endSeconds);
    const levelRaw = finiteNumber(chapter.level);
    const index = finiteNumber(chapter.index);
    const startFraction =
      startFractionRaw == null ? 0 : Math.min(1, Math.max(0, startFractionRaw));
    let children: PlayerChapter[] | undefined;
    if (depth < MAX_DEPTH && Array.isArray(chapter.children)) {
      const nested = chapter.children.flatMap((child) => {
        const parsed = one(child, depth + 1);
        return parsed ? [parsed] : [];
      });
      if (nested.length > 0) children = nested;
    }
    const level =
      levelRaw != null && levelRaw >= 1 && levelRaw <= MAX_DEPTH
        ? Math.round(levelRaw)
        : undefined;
    return {
      ...(index != null ? { index } : {}),
      title,
      ...(subtitle ? { subtitle } : {}),
      startFraction,
      ...(startSeconds != null && startSeconds >= 0 ? { startSeconds } : {}),
      ...(endSeconds != null && endSeconds >= 0 ? { endSeconds } : {}),
      ...(level != null ? { level } : {}),
      ...(children ? { children } : {}),
    };
  };
  return input.flatMap((row) => {
    const parsed = one(row, 1);
    return parsed ? [parsed] : [];
  });
}

function toNode(chapter: PlayerChapter): ChapterNode {
  return {
    id: "",
    title: chapter.title.replace(/\s+/g, " ").trim(),
    ...(chapter.subtitle ? { subtitle: chapter.subtitle.replace(/\s+/g, " ").trim() } : {}),
    startFraction: Number.isFinite(chapter.startFraction)
      ? Math.min(1, Math.max(0, chapter.startFraction))
      : 0,
    ...(chapter.startSeconds != null && chapter.startSeconds >= 0
      ? { startSeconds: chapter.startSeconds }
      : {}),
    ...(chapter.endSeconds != null && chapter.endSeconds >= 0
      ? { endSeconds: chapter.endSeconds }
      : {}),
    children: [],
  };
}

function assignIds(nodes: ChapterNode[], prefix = ""): ChapterNode[] {
  return nodes.map((node, index) => {
    const id = prefix ? `${prefix}.${index}` : String(index);
    return { ...node, id, children: assignIds(node.children, id) };
  });
}

function attach(chapter: PlayerChapter, depth: number): ChapterNode {
  const node = toNode(chapter);
  if (depth >= MAX_DEPTH) return node;
  node.children = (chapter.children ?? []).map((child) => attach(child, depth + 1));
  return node;
}

/** `level: 2` (and deeper) rows belong to the nearest shallower row above them. */
function groupByLevel(raw: PlayerChapter[]): ChapterNode[] {
  const roots: ChapterNode[] = [];
  const stack: Array<{ level: number; node: ChapterNode }> = [];
  for (const chapter of raw) {
    const level =
      typeof chapter.level === "number" && chapter.level > 1
        ? Math.min(MAX_DEPTH, Math.round(chapter.level))
        : 1;
    const node = toNode(chapter);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1]!.node.children.push(node);
    stack.push({ level, node });
  }
  return roots;
}

function leaves(node: ChapterNode): ChapterNode[] {
  return node.children.length > 0 ? node.children.flatMap(leaves) : [node];
}

export function normalizeChapters(
  input: readonly PlayerChapter[] | null | undefined
): { parts: ChapterNode[]; steps: ChapterNode[]; ticks: ChapterTick[] } {
  const raw = (input ?? []).filter(
    (chapter) => chapter && typeof chapter.title === "string" && chapter.title.trim()
  );
  const nested = raw.some((chapter) => (chapter.children?.length ?? 0) > 0);
  const parts = assignIds(nested ? raw.map((chapter) => attach(chapter, 1)) : groupByLevel(raw));
  return {
    parts,
    steps: parts.flatMap(leaves),
    ticks: parts.map((part) => ({ startFraction: part.startFraction, title: part.title })),
  };
}

function chapterStart(node: ChapterNode, duration: number): number | null {
  if (typeof node.startSeconds === "number" && Number.isFinite(node.startSeconds)) {
    return Math.max(0, node.startSeconds);
  }
  if (!(duration > 0) || !Number.isFinite(node.startFraction)) return null;
  return Math.min(duration, Math.max(0, node.startFraction * duration));
}

function resolveEnd(
  explicit: number | undefined,
  nextStart: number | null,
  parentEnd: number | null,
  duration: number,
  start: number
): number {
  if (typeof explicit === "number" && explicit >= start) return explicit;
  if (nextStart != null && nextStart > start) return nextStart;
  if (parentEnd != null && parentEnd > start) return parentEnd;
  if (duration > start) return duration;
  return start;
}

function timeList(nodes: ChapterNode[], duration: number, parentEnd: number | null): Timed[] {
  const placed: Array<{ node: ChapterNode; start: number }> = [];
  for (const node of nodes) {
    const start = chapterStart(node, duration);
    if (start == null) continue;
    placed.push({ node, start });
  }
  return placed.map((item, index) => {
    const nextStart = placed[index + 1]?.start ?? null;
    const end = resolveEnd(item.node.endSeconds, nextStart, parentEnd, duration, item.start);
    return {
      node: item.node,
      start: item.start,
      end,
      children: timeList(item.node.children, duration, end),
    };
  });
}

function flattenTimed(nodes: Timed[]): Timed[] {
  return nodes.flatMap((node) => (node.children.length > 0 ? flattenTimed(node.children) : [node]));
}

/** Deepest chapter that has started. A part intro (before its first sub-chapter) stays the part. */
function locate(nodes: Timed[], time: number): Timed | null {
  let found: Timed | null = null;
  for (const node of nodes) {
    if (node.start <= time + 0.05) found = node;
  }
  if (!found) return null;
  if (found.children.length === 0) return found;
  return locate(found.children, time) ?? found;
}

function partOf(parts: Timed[], id: string): Timed | null {
  for (const part of parts) {
    if (part.node.id === id || contains(part, id)) return part;
  }
  return null;
}

function contains(node: Timed, id: string): boolean {
  if (node.node.id === id) return true;
  return node.children.some((child) => contains(child, id));
}

/** Compact clock for the quiet line and the row's length: "1 h 12 m", "22 m", "40 s". */
export function formatChapterSpan(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0 && minutes > 0) return `${hours} h ${minutes} m`;
  if (hours > 0) return `${hours} h`;
  if (minutes > 0) return `${minutes} m`;
  return `${secs} s`;
}

/** Spoken length for a row's accessible name. Seconds stay when the chapter is under an hour. */
export function formatSpokenDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (hours === 0 && (secs > 0 || parts.length === 0)) {
    parts.push(`${secs} ${secs === 1 ? "second" : "seconds"}`);
  }
  return parts.join(" ");
}

function rowLabel(
  partIndex: number,
  partCount: number,
  partTitle: string,
  node: ChapterNode,
  nested: boolean,
  start: number,
  length: number
): string {
  const clock = formatPlayClock(start);
  const spoken = formatSpokenDuration(length);
  let name: string;
  if (nested) {
    name = node.subtitle
      ? `${partTitle}: ${node.title}, ${node.subtitle}`
      : `${partTitle}: ${node.title}`;
  } else if (node.subtitle) {
    name = `${node.title}: ${node.subtitle}`;
  } else {
    name = node.title;
  }
  return `Chapter ${partIndex} of ${partCount}, ${name}, starts ${clock}, ${spoken}`;
}

function rowsFrom(timed: Timed, partIndex: number, partCount: number, part: Timed, depth: number): ChapterRow {
  const length = Math.max(0, timed.end - timed.start);
  return {
    id: timed.node.id,
    node: timed.node,
    title: timed.node.title,
    ...(timed.node.subtitle ? { subtitle: timed.node.subtitle } : {}),
    start: timed.start,
    length,
    label: rowLabel(partIndex, partCount, part.node.title, timed.node, depth > 0, timed.start, length),
    depth,
    children: timed.children.map((child) => rowsFrom(child, partIndex, partCount, part, depth + 1)),
  };
}

function spotLine(part: Timed, node: Timed, time: number, partIndex: number, partCount: number): string {
  const left = formatChapterSpan(Math.max(0, node.end - time));
  if (node.node.id !== part.node.id) {
    return `${part.node.title} · ${node.node.title} · ${left} left`;
  }
  return `${part.node.title} · ${partIndex} of ${partCount} · ${left} left in chapter`;
}

function dragText(part: Timed, node: Timed): string {
  if (node.node.id === part.node.id) return part.node.title;
  return `${part.node.title} · ${node.node.title}`;
}

export function mediaSessionFields(input: {
  bookTitle: string;
  chapterLabel?: string | null;
  voiceName?: string | null;
}): { title: string; artist?: string; album?: string } {
  const title = input.bookTitle.replace(/\s+/g, " ").trim() || "Audiobook";
  const chapter = input.chapterLabel?.replace(/\s+/g, " ").trim() || "";
  const voice = input.voiceName?.replace(/\s+/g, " ").trim() || "";
  if (chapter && voice) return { title, artist: chapter, album: voice };
  if (chapter) return { title, artist: chapter };
  if (voice) return { title, artist: voice };
  return { title };
}

const EMPTY: ChapterView = {
  enabled: false,
  rows: [],
  ticks: [],
  line: null,
  dragLabel: null,
  activeId: null,
  activePartId: null,
  previous: null,
  next: null,
};

/**
 * One pass over the chapter list: the quiet line, the skip targets, the
 * rows, and the scrubber ticks. Sub-chapters are the skip steps when a part
 * has them; a part with none is itself a step.
 */
export function chapterView(
  chapters: readonly PlayerChapter[] | null | undefined,
  time: number,
  duration: number
): ChapterView {
  const outline = normalizeChapters(chapters);
  if (outline.steps.length < 2) return EMPTY;
  const at = Number.isFinite(time) ? Math.max(0, time) : 0;
  const parentEnd = duration > 0 ? duration : null;
  const parts = timeList(outline.parts, duration, parentEnd);
  if (parts.length === 0) return { ...EMPTY, ticks: outline.ticks };
  const steps = flattenTimed(parts);
  if (steps.length < 2) return { ...EMPTY, ticks: outline.ticks };
  const node = locate(parts, at);
  const part = node ? partOf(parts, node.node.id) : null;
  const rows = parts.map((item, index) => rowsFrom(item, index + 1, parts.length, item, 0));
  const partIndex = part ? parts.findIndex((item) => item.node.id === part.node.id) + 1 : 0;

  let previous: ChapterNode | null = null;
  let next: ChapterNode | null = null;
  if (node) {
    const into = at - node.start;
    const stepIndex = steps.findIndex((step) => step.node.id === node.node.id);
    if (into > CHAPTER_RESTART_SECONDS) {
      previous = node.node;
    } else if (stepIndex > 0) {
      previous = steps[stepIndex - 1]!.node;
    } else if (stepIndex < 0) {
      const prior = [...steps].reverse().find((step) => step.start < node.start - 0.05);
      previous = prior?.node ?? null;
    }
    if (stepIndex >= 0) next = steps[stepIndex + 1]?.node ?? null;
    else next = steps.find((step) => step.start > at + 0.05)?.node ?? null;
  } else {
    next = steps[0]?.node ?? null;
  }

  return {
    enabled: true,
    rows,
    ticks: outline.ticks,
    line:
      part && node
        ? spotLine(part, node, at, partIndex, parts.length)
        : `Chapters · ${parts.length}`,
    dragLabel: part && node ? dragText(part, node) : null,
    activeId: node?.node.id ?? null,
    activePartId: part?.node.id ?? null,
    previous,
    next,
  };
}
