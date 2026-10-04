"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatPlayClock } from "@/lib/player/seek";
import {
  formatChapterSpan,
  type ChapterNode,
  type ChapterRow,
} from "@/lib/player/chapter-nav";

const STORAGE_PREFIX = "ec-player-chapters:";

export function chapterListStorageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

const memoryOpen = new Map<string, boolean>();
const openListeners = new Set<() => void>();
const MOBILE_SHEET = "(max-width: 767px)";
const CHAPTER_TRIGGER_ID = "player-chapter-trigger";

function subscribeMobileSheet(listener: () => void) {
  const query = window.matchMedia(MOBILE_SHEET);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function mobileSheetSnapshot() {
  return window.matchMedia(MOBILE_SHEET).matches;
}

function mobileSheetServerSnapshot() {
  return false;
}

function subscribeChapterList(listener: () => void) {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

function chapterListSnapshot(id: string): boolean {
  const remembered = memoryOpen.get(id);
  if (remembered != null) return remembered;
  try {
    return window.localStorage.getItem(chapterListStorageKey(id)) === "1";
  } catch {
    return false;
  }
}

function rememberChapterList(id: string, open: boolean) {
  memoryOpen.set(id, open);
  try {
    window.localStorage.setItem(chapterListStorageKey(id), open ? "1" : "0");
  } catch {
    // Private mode can reject storage. The in-memory value still holds for this visit.
  }
  openListeners.forEach((listener) => listener());
}

function chapterListServerSnapshot() {
  return false;
}

/** Whether this book’s chapter list was left open. Defaults to closed. */
export function useChapterListOpen(id: string): [boolean, () => void] {
  const snapshot = useCallback(() => chapterListSnapshot(id), [id]);
  const open = useSyncExternalStore(subscribeChapterList, snapshot, chapterListServerSnapshot);
  const toggle = useCallback(() => {
    rememberChapterList(id, !chapterListSnapshot(id));
  }, [id]);
  return [open, toggle];
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function RowButton({
  row,
  current,
  quiet,
  onSeek,
}: {
  row: ChapterRow;
  current: boolean;
  quiet: boolean;
  onSeek: (chapter: ChapterNode) => void;
}) {
  return (
    <button
      type="button"
      data-current={current ? "true" : undefined}
      aria-current={current ? "true" : undefined}
      aria-label={row.label}
      onClick={() => onSeek(row.node)}
      className={`flex min-h-12 min-w-0 flex-1 items-center gap-3 py-2 pr-3 text-left ${
        current
          ? "font-medium text-foreground"
          : quiet
            ? "font-normal text-muted-foreground"
            : "font-normal text-foreground/80"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 font-serif text-lg leading-snug">{row.title}</span>
        {row.subtitle ? (
          <span className="line-clamp-2 text-sm leading-snug text-muted-foreground">
            {row.subtitle}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right font-mono text-[11px] leading-4 text-muted-foreground tabular-nums">
        <span className="block">{formatPlayClock(row.start)}</span>
        <span className="block">{formatChapterSpan(row.length)}</span>
      </span>
    </button>
  );
}

function ChapterBranch({
  row,
  activeId,
  activePartId,
  extraOpen,
  closed,
  onToggle,
  onSeek,
}: {
  row: ChapterRow;
  activeId: string | null;
  activePartId: string | null;
  extraOpen: Set<string>;
  closed: Set<string>;
  onToggle: (id: string) => void;
  onSeek: (chapter: ChapterNode) => void;
}) {
  const current = row.id === activeId;
  const hasChildren = row.children.length > 0;
  const expanded =
    hasChildren &&
    (row.depth > 0 ||
      (!closed.has(row.id) && (row.id === activePartId || extraOpen.has(row.id))));
  const indent = row.depth === 1 ? "pl-12" : row.depth > 1 ? "pl-20" : "";
  return (
    <li className={current ? "border-l border-l-foreground" : "border-l border-l-transparent"}>
      <div className="flex min-h-12 items-stretch border-b border-foreground/10">
        {row.depth === 0 && hasChildren ? (
          <button
            type="button"
            className="inline-flex min-h-12 w-12 shrink-0 items-center justify-center text-muted-foreground"
            aria-expanded={expanded}
            aria-controls={`player-part-${row.id}`}
            aria-label={`${expanded ? "Hide" : "Show"} chapters in ${row.title}`}
            onClick={() => onToggle(row.id)}
          >
            <Chevron open={expanded} />
          </button>
        ) : row.depth === 0 ? (
          <span className="w-3 shrink-0" aria-hidden="true" />
        ) : null}
        <div className={`flex min-w-0 flex-1 ${indent}`}>
          <RowButton row={row} current={current} quiet={row.depth > 0} onSeek={onSeek} />
        </div>
      </div>
      {expanded ? (
        <ol id={`player-part-${row.id}`} aria-label={`Chapters in ${row.title}`} className="m-0 list-none p-0">
          {row.children.map((child) => (
            <ChapterBranch
              key={child.id}
              row={child}
              activeId={activeId}
              activePartId={activePartId}
              extraOpen={extraOpen}
              closed={closed}
              onToggle={onToggle}
              onSeek={onSeek}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

/**
 * Full-height chapter sheet on a phone and a side panel on a wider screen.
 * The phone sheet ends at the tab bar (73px: that nav's border, padding,
 * icon, and label). One scroll. The part that holds the playhead starts
 * open; the others start closed.
 */
export function PlayerChapterSheet({
  open,
  rows,
  activeId,
  activePartId,
  onClose,
  onSeek,
}: {
  open: boolean;
  rows: ChapterRow[];
  activeId: string | null;
  activePartId: string | null;
  onClose: () => void;
  onSeek: (chapter: ChapterNode) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const modal = useSyncExternalStore(
    subscribeMobileSheet,
    mobileSheetSnapshot,
    mobileSheetServerSnapshot
  );
  const [extraOpen, setExtraOpen] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [tracked, setTracked] = useState<{ open: boolean; part: string | null }>({
    open: false,
    part: null,
  });
  const didFocus = useRef(false);

  // Reset when the sheet opens, and follow the playhead into a part the
  // listener had collapsed. This is state derived from props, not an effect.
  if (open !== tracked.open || (open && activePartId !== tracked.part)) {
    const opening = open && !tracked.open;
    setTracked({ open, part: open ? activePartId : tracked.part });
    if (opening) {
      setExtraOpen(new Set());
      setClosed(new Set());
    } else if (open && activePartId && closed.has(activePartId)) {
      const partId = activePartId;
      setClosed((prev) => {
        if (!prev.has(partId)) return prev;
        const next = new Set(prev);
        next.delete(partId);
        return next;
      });
    }
  }

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      if (didFocus.current) {
        didFocus.current = false;
        document.getElementById(CHAPTER_TRIGGER_ID)?.focus();
      }
      return;
    }
    const root = sheetRef.current;
    if (!root) return;
    const current = root.querySelector<HTMLElement>("[data-current='true']");
    if (current) {
      const rootRect = root.getBoundingClientRect();
      const rowRect = current.getBoundingClientRect();
      const delta = rowRect.top - rootRect.top - root.clientHeight / 2 + rowRect.height / 2;
      root.scrollTop += delta;
    }
    if (!didFocus.current) {
      const target = current ?? root.querySelector<HTMLElement>("[data-sheet-close]");
      if (!target) return;
      didFocus.current = true;
      target.focus({ preventScroll: true });
    }
  }, [open, activeId]);

  const togglePart = (id: string) => {
    const hasChildren = true;
    const isOpen = hasChildren && !closed.has(id) && (id === activePartId || extraOpen.has(id));
    if (isOpen) {
      setClosed((prev) => new Set(prev).add(id));
      setExtraOpen((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    setClosed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setExtraOpen((prev) => new Set(prev).add(id));
  };

  if (!open) return null;

  return (
    <div
      ref={sheetRef}
      role={modal ? "dialog" : undefined}
      aria-modal={modal ? true : undefined}
      aria-labelledby={modal ? "player-chapters-heading" : undefined}
      className="fixed inset-x-0 top-16 bottom-[73px] z-40 overflow-y-auto overscroll-contain bg-background md:bottom-0 md:left-auto md:w-80 md:border-l md:border-foreground/15"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between bg-background px-4">
        <h2
          id="player-chapters-heading"
          className="font-serif text-2xl tracking-tight text-foreground"
          style={{ fontWeight: 300 }}
        >
          Chapters
        </h2>
        <button
          type="button"
          data-sheet-close=""
          onClick={onClose}
          className="inline-flex min-h-12 items-center px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Close
        </button>
      </div>
      <nav id="player-chapters" aria-label="Chapters">
        <ol className="m-0 list-none p-0">
          {rows.map((row) => (
            <ChapterBranch
              key={row.id}
              row={row}
              activeId={activeId}
              activePartId={activePartId}
              extraOpen={extraOpen}
              closed={closed}
              onToggle={togglePart}
              onSeek={onSeek}
            />
          ))}
        </ol>
      </nav>
    </div>
  );
}

export function NowPlayingLine({
  line,
  open,
  onToggle,
}: {
  line: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      id={CHAPTER_TRIGGER_ID}
      data-testid="now-playing"
      aria-expanded={open}
      aria-controls={open ? "player-chapters" : undefined}
      onClick={onToggle}
      className="tap mx-auto mt-1 flex w-fit max-w-full min-h-12 items-center justify-center gap-1.5 px-3 text-center font-serif text-sm leading-snug text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className="underline decoration-foreground/35 underline-offset-[0.35em]">{line}</span>
      <svg
        viewBox="0 0 24 24"
        className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}
