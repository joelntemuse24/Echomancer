"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BOOKMARK_NOTICE_MS,
  sortBookmarks,
  withSavedBookmark,
  withoutBookmark,
  type BookmarkNotice,
  type JobBookmark,
  type SaveBookmarkInput,
} from "@/lib/player/bookmarks";

/**
 * Marks for one book. Both player bars share this so a save in focus mode
 * is the same list the main bar shows.
 */
export function useJobBookmarks(jobId: string) {
  const [bookmarks, setBookmarks] = useState<JobBookmark[]>([]);
  const [notice, setNotice] = useState<BookmarkNotice | null>(null);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBookmarks([]);
    setNotice(null);
    void fetch(`/api/jobs/${jobId}/bookmarks`, { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body: { bookmarks?: JobBookmark[] } | null) => {
        if (cancelled || !body || !Array.isArray(body.bookmarks)) return;
        setBookmarks(sortBookmarks(body.bookmarks));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const flash = useCallback((next: BookmarkNotice) => {
    setNotice(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), BOOKMARK_NOTICE_MS);
  }, []);

  const save = useCallback(
    async (input: SaveBookmarkInput) => {
      setPending(true);
      try {
        const response = await fetch(`/api/jobs/${jobId}/bookmarks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          flash("error");
          return;
        }
        const body = (await response.json()) as {
          bookmark?: JobBookmark;
          duplicate?: boolean;
        };
        if (!body.bookmark) {
          flash("error");
          return;
        }
        const saved = body.bookmark;
        setBookmarks((rows) => withSavedBookmark(rows, saved));
        flash(body.duplicate ? "duplicate" : "saved");
      } catch {
        flash("error");
      } finally {
        setPending(false);
      }
    },
    [jobId, flash]
  );

  const remove = useCallback(
    async (bookmarkId: string) => {
      setBookmarks((rows) => withoutBookmark(rows, bookmarkId));
      try {
        const response = await fetch(`/api/jobs/${jobId}/bookmarks/${bookmarkId}`, {
          method: "DELETE",
        });
        if (response.ok) return;
        const list = await fetch(`/api/jobs/${jobId}/bookmarks`, { cache: "no-store" });
        if (!list.ok) return;
        const body = (await list.json()) as { bookmarks?: JobBookmark[] };
        if (Array.isArray(body.bookmarks)) setBookmarks(sortBookmarks(body.bookmarks));
      } catch {
        // The next visit reloads the list.
      }
    },
    [jobId]
  );

  return { bookmarks, notice, pending, save, remove };
}
