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
  return Array.isArray(raw) ? raw : [];
}

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
  const [state, setState] = useState<UploadExtractState>(() => ({
    status: charCount > 0 || !uploadId ? "ready" : "preparing",
    chars: charCount,
    error: null,
    chapters: [],
  }));

  useEffect(() => {
    if (!uploadId) return;
    const ac = new AbortController();
    if (charCount > 0) {
      void fetch(`/api/pdf/upload/${uploadId}`, { signal: ac.signal })
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as { chapters?: UploadChapter[] };
          setState((prev) => ({
            ...prev,
            chapters: chapterList(data.chapters),
          }));
        })
        .catch(() => {});
      return () => ac.abort();
    }
    setState({
      status: "preparing",
      chars: 0,
      error: null,
      chapters: [],
    });
    void waitForUploadExtract(uploadId, { signal: ac.signal })
      .then((data) => {
        setState({
          status: "ready",
          chars: data.charCount ?? 0,
          error: null,
          chapters: chapterList(data.chapters),
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
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
  }, [uploadId, charCount]);

  return state;
}
