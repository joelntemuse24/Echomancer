"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BOOKMARK_NOTICE_MS,
  bookmarkSavedText,
  bookmarkNoticeAfterResponse,
  bookmarkSaveTap,
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
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookmarksRef = useRef(bookmarks);
  const pendingRef = useRef(false);
  const epoch = useRef(0);
  const inflight = useRef(0);
  bookmarksRef.current = bookmarks;

  useEffect(() => {
    let cancelled = false;
    setBookmarks([]);
    setNotice(null);
    setNoticeText(null);
    void fetch(`/api/jobs/${jobId}/bookmarks`, { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body: { bookmarks?: JobBookmark[] } | null) => {
        if (cancelled || !body || !Array.isArray(body.bookmarks)) return;
        const next = sortBookmarks(body.bookmarks);
        bookmarksRef.current = next;
        setBookmarks(next);
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

  const flash = useCallback((next: BookmarkNotice, text?: string) => {
    setNotice(next);
    setNoticeText(text ?? null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setNotice(null);
      setNoticeText(null);
    }, BOOKMARK_NOTICE_MS);
  }, []);

  const save = useCallback(
    async (
      input: SaveBookmarkInput,
      dedupeAgainst?: readonly { positionSeconds: number; sectionIndex: number | null }[]
    ) => {
      const tap = bookmarkSaveTap({
        pending: pendingRef.current,
        bookmarks: dedupeAgainst ?? bookmarksRef.current,
        positionSeconds: input.positionSeconds,
        sectionIndex: input.sectionIndex,
      });
      if (tap === "duplicate") {
        // The in-flight response must not replace this notice with "Saved".
        epoch.current += 1;
        flash("duplicate");
        return;
      }
      const token = epoch.current + 1;
      epoch.current = token;
      inflight.current = token;
      pendingRef.current = true;
      setPending(true);
      try {
        const response = await fetch(`/api/jobs/${jobId}/bookmarks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const body = response.ok
          ? ((await response.json()) as { bookmark?: JobBookmark; duplicate?: boolean })
          : null;
        if (body?.bookmark) {
          const saved = body.bookmark;
          bookmarksRef.current = withSavedBookmark(bookmarksRef.current, saved);
          setBookmarks(bookmarksRef.current);
        }
        const next = bookmarkNoticeAfterResponse({
          httpOk: response.ok,
          hasBookmark: Boolean(body?.bookmark),
          duplicate: body?.duplicate,
          requestEpoch: token,
          currentEpoch: epoch.current,
        });
        if (next) {
          flash(
            next,
            next === "saved" ? bookmarkSavedText(input.positionSeconds) : undefined
          );
        }
      } catch {
        const next = bookmarkNoticeAfterResponse({
          httpOk: false,
          hasBookmark: false,
          requestEpoch: token,
          currentEpoch: epoch.current,
        });
        if (next) {
          flash(
            next,
            next === "saved" ? bookmarkSavedText(input.positionSeconds) : undefined
          );
        }
      } finally {
        if (inflight.current === token) {
          pendingRef.current = false;
          setPending(false);
        }
      }
    },
    [jobId, flash]
  );

  const remove = useCallback(
    async (bookmarkId: string) => {
      setBookmarks((rows) => {
        const next = withoutBookmark(rows, bookmarkId);
        bookmarksRef.current = next;
        return next;
      });
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

  return { bookmarks, notice, noticeText, pending, save, remove };
}
