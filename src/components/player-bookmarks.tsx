"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bookmark, ChevronDown, X } from "lucide-react";
import {
  BOOKMARK_LIST_DISMISS_EVENT,
  BOOKMARK_NOTICE_TEXT,
  bookmarkListKeyAction,
  bookmarkPlaceLabel,
  type BookmarkNotice,
  type JobBookmark,
} from "@/lib/player/bookmarks";
import { cn } from "@/lib/utils";

const controlButton =
  "relative z-30 inline-flex items-center justify-center text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-30";

export function BookmarkList({
  bookmarks,
  onJump,
  onRemove,
  className,
  id,
}: {
  bookmarks: readonly JobBookmark[];
  onJump: (bookmark: JobBookmark) => void;
  onRemove: (id: string) => void;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      role="dialog"
      aria-label="Bookmarks"
      data-testid="bookmark-list"
      data-bookmark-list=""
      className={cn(
        "z-30 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-border/50 bg-background shadow-xl",
        className
      )}
    >
      {bookmarks.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">No bookmarks</p>
      ) : (
        <ul className="max-h-[min(16rem,50vh)] overflow-y-auto py-1">
          {bookmarks.map((bookmark) => {
            const place = bookmarkPlaceLabel(bookmark);
            return (
              <li key={bookmark.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => onJump(bookmark)}
                  className="min-h-11 min-w-0 flex-1 px-3 py-2 text-left hover:bg-accent"
                >
                  <span className="block font-sans text-xs text-foreground">{place}</span>
                  {bookmark.label ? (
                    <span className="block truncate font-sans text-[11px] text-muted-foreground">
                      {bookmark.label}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`Remove bookmark at ${place}`}
                  onClick={() => onRemove(bookmark.id)}
                  className={cn(controlButton, "min-h-11 min-w-11 text-muted-foreground")}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.5} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One tap stores the playhead. The chevron opens the marks for this book.
 * The same control sits on the main player and in focus mode.
 */
export function PlayerBookmarks({
  bookmarks,
  disabled,
  pending = false,
  notice,
  onSave,
  onJump,
  onRemove,
  defaultOpen = false,
}: {
  bookmarks: readonly JobBookmark[];
  disabled: boolean;
  pending?: boolean;
  notice: BookmarkNotice | null;
  onSave: () => void;
  onJump: (bookmark: JobBookmark) => void;
  onRemove: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const message = notice ? BOOKMARK_NOTICE_TEXT[notice] : "";
  const countLabel =
    bookmarks.length > 0 ? `Bookmarks, ${bookmarks.length}` : "Bookmarks";

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    // Capture runs before focus mode's window listener, which would otherwise
    // keep the list open (it returns when the list is in the tree) or leave
    // the view. Escape closes only the list.
    const onKey = (event: KeyboardEvent) => {
      if (bookmarkListKeyAction(event.key) !== "close") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener(BOOKMARK_LIST_DISMISS_EVENT, close);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener(BOOKMARK_LIST_DISMISS_EVENT, close);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      data-bookmark-open={open ? "true" : "false"}
      className="relative z-30 inline-flex items-center"
    >
      <button
        type="button"
        data-testid="save-bookmark"
        data-bookmark-state={notice ?? "idle"}
        aria-label="Save bookmark"
        aria-busy={pending || undefined}
        disabled={disabled || pending}
        onClick={onSave}
        className={cn(controlButton, "min-h-11 min-w-11", open && "text-foreground")}
      >
        <Bookmark
          aria-hidden="true"
          className="h-5 w-5"
          strokeWidth={1.5}
          fill={notice === "saved" ? "currentColor" : "none"}
        />
      </button>
      <button
        type="button"
        data-testid="bookmark-list-toggle"
        aria-label={countLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          controlButton,
          "min-h-11 min-w-11",
          open ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
          strokeWidth={1.5}
        />
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-20 bg-background md:hidden"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <BookmarkList
            id={listId}
            bookmarks={bookmarks}
            onJump={(bookmark) => {
              onJump(bookmark);
              setOpen(false);
            }}
            onRemove={onRemove}
            className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2"
          />
        </>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        data-testid="bookmark-notice"
        className={cn(
          "pointer-events-none absolute bottom-full left-1/2 z-40 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-background px-2 py-1 font-sans text-xs text-foreground",
          message ? "border border-border/60 shadow-sm" : "sr-only"
        )}
      >
        {message}
      </span>
    </div>
  );
}
