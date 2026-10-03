"use client";

/**
 * The one upload-status poller. The voice page used to run two — a mount
 * effect *and* a second wait inside Make audiobook — hammering the status
 * route twice a second and racing on the same state. This hook is the single
 * reader: `waitForUploadExtract` owns the retry/backoff and hidden-tab
 * behavior, so a phone tab that slept or lost signal keeps waiting instead of
 * failing on its first dead poll.
 */

import { useEffect, useState } from "react";
import {
  waitForUploadExtract,
  type UploadChapter,
} from "@/lib/upload-client";

export interface UploadExtractState {
  status: "ready" | "preparing" | "failed";
  chars: number;
  error: string | null;
  chapters: UploadChapter[];
}

function chapterList(raw: unknown): UploadChapter[] {
  return Array.isArray(raw) ? (raw as UploadChapter[]) : [];
}

/** What the hook reports before any answer has arrived for this target. */
function pendingState(
  uploadId: string | null,
  charCount: number
): UploadExtractState {
  return {
    status: !uploadId || charCount > 0 ? "ready" : "preparing",
    chars: charCount,
    error: null,
    chapters: [],
  };
}

type Snapshot = { key: string } & UploadExtractState;

/**
 * @param uploadId the upload to watch; null means there is nothing to wait on
 * @param initial.charCount a count that arrived with the URL means the text
 *   already existed at intake — no polling, just one chapter read
 */
export function useUploadExtractStatus(
  uploadId: string | null,
  initial: { charCount: number }
): UploadExtractState {
  const charCount = initial.charCount;
  const watch = charCount === 0;
  // Answers are keyed by what they were asked about, so a changed target
  // falls back to the pending state without a setState in the effect body.
  const key = uploadId ? `${uploadId}|${watch}` : "";

  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    key,
    ...pendingState(uploadId, charCount),
  }));

  useEffect(() => {
    if (!uploadId) return;
    const ac = new AbortController();
    if (!watch) {
      // The text existed at intake: one chapter read, no polling.
      void fetch(`/api/pdf/upload/${uploadId}`, { signal: ac.signal })
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as { chapters?: UploadChapter[] };
          setSnapshot({
            key,
            status: "ready",
            chars: charCount,
            error: null,
            chapters: chapterList(data.chapters),
          });
        })
        .catch(() => {});
      return () => ac.abort();
    }
    void waitForUploadExtract(uploadId, { signal: ac.signal })
      .then((data) => {
        setSnapshot({
          key,
          status: "ready",
          chars: data.charCount ?? 0,
          error: null,
          chapters: chapterList(data.chapters),
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setSnapshot({
          key,
          status: "failed",
          chars: 0,
          error:
            err instanceof Error
              ? err.message
              : "Couldn't read this document. Try another file.",
          chapters: [],
        });
      });
    return () => ac.abort();
  }, [uploadId, watch, key, charCount]);

  if (snapshot.key !== key) return pendingState(uploadId, charCount);
  return {
    status: snapshot.status,
    chars: snapshot.chars,
    error: snapshot.error,
    chapters: snapshot.chapters,
  };
}
