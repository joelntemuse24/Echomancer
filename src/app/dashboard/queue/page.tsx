"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { userFriendlyError } from "@/lib/errors-ui";
import { EditableBookTitle } from "@/components/editable-book-title";
import { ProgressLine } from "@/components/progress-line";
import { libraryStatus, UX } from "@/lib/ux-copy";
import {
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "@/lib/download-client";

interface Job {
  id: string;
  book_title: string;
  voice_name: string | null;
  status: "queued" | "processing" | "ready" | "failed" | "cancelled";
  progress: number;
  current_section: number;
  total_sections: number;
  audio_url?: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  warning?: string | null;
  created_at: string;
  updated_at: string;
  job_kind?: string | null;
  generation_mode?: string | null;
  tts_provider?: string | null;
  segments?: Array<{ index: number; path: string; status: string }> | null;
  stream_chars_used?: number | null;
  stream_max_chars?: number | null;
  eta_seconds?: number | null;
  eta_label?: string | null;
  elapsed_seconds?: number | null;
  elapsed_label?: string | null;
}

export default function QueuePage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** One quiet line per card for the last action on that book. */
  const [notices, setNotices] = useState<Record<string, string>>({});
  const setNotice = (jobId: string, message: string | null) =>
    setNotices((prev) => {
      const next = { ...prev };
      if (message) next[jobId] = message;
      else delete next[jobId];
      return next;
    });

  // Initial fetch — shows the full-page loader
  const fetchJobs = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const response = await fetch("/api/jobs");
      if (!response.ok) throw new Error("Couldn't load your library.");
      const data = await response.json();
      setJobs(data.jobs || []);
      setFetchError(null);
    } catch (error) {
      console.error("Failed to fetch jobs:", error);
      setFetchError(error instanceof Error ? error.message : "Couldn't load your library.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Background poll — silently updates data, NEVER toggles the loader
  const refreshJobs = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs");
      if (!response.ok) return;
      const data = await response.json();
      setJobs(data.jobs || []);
    } catch {
      // Silently ignore polling errors
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Polling for real-time updates (every 3 seconds, only when tab visible)
  const refreshRef = useRef(refreshJobs);
  refreshRef.current = refreshJobs;
  const hasActive = jobs.some(j => j.status === "processing" || j.status === "queued");
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshRef.current();
      }
    }, 3000);
    return () => clearInterval(id);
  }, [hasActive]);

  /**
   * Where a card's "Listen" link points. Take-home jobs open in segment mode
   * once any section is ready so a listener can start before the book finishes.
   */
  const playerHref = (job: Job): string => {
    if (job.job_kind === "stream") {
      return `/dashboard/player/${job.id}?mode=stream`;
    }
    const hasReadySection = job.segments?.some((s) => s.status === "ready");
    return hasReadySection && job.status !== "ready"
      ? `/dashboard/player/${job.id}?mode=segments`
      : `/dashboard/player/${job.id}`;
  };

  const canPlay = (job: Job): boolean =>
    job.status === "ready" ||
    job.job_kind === "stream" ||
    (job.segments?.some((s) => s.status === "ready") ?? false);

  /** Open the player — including while generating, so progress is visible. */
  const canOpen = (job: Job): boolean =>
    canPlay(job) || job.status === "processing" || job.status === "queued";

  const openLabel = (job: Job): string => {
    if (canPlay(job)) return "Listen";
    if (job.status === "processing" || job.status === "queued") return "Progress";
    return "Open";
  };

  const handleDownload = (e: React.MouseEvent, job: Job) => {
    e.stopPropagation();
    if (job.status !== "ready" && !job.segments?.some((s) => s.status === "ready")) {
      setNotice(job.id, "Not ready to download yet.");
      return;
    }
    try {
      startAudiobookDownload(
        `/api/jobs/${job.id}/download`,
        audiobookFilename(job.book_title)
      );
      setNotice(job.id, isIosDownload() ? UX.downloadOpened : null);
    } catch (err) {
      setNotice(job.id, err instanceof Error ? err.message : "Download failed. Try again.");
    }
  };

  const handleDelete = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    if (!confirm("Delete this audiobook?")) return;
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Couldn't delete. Try again.");
      }
      setJobs(prev => prev.filter(job => job.id !== jobId));
      setNotice(jobId, null);
    } catch (error) {
      setNotice(jobId, error instanceof Error ? error.message : "Couldn't delete. Try again.");
    }
  };

  const handleCancel = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    try {
      const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Couldn't cancel. Try again.");
      }
      setNotice(jobId, null);
      refreshJobs();
    } catch (error) {
      setNotice(jobId, error instanceof Error ? error.message : "Couldn't cancel. Try again.");
    }
  };

  const handleRetry = async (e: React.MouseEvent, job: Job) => {
    e.stopPropagation();
    try {
      const response = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry" }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Couldn't retry. Try again.");
      }

      setNotice(job.id, null);
      refreshJobs();
    } catch (error) {
      setNotice(job.id, error instanceof Error ? error.message : "Couldn't retry. Try again.");
    }
  };

  const progressSuffix = (job: Job): string => {
    if (!job.eta_label) return "";
    return ` · ${job.eta_label} left`;
  };

  const statusFor = (job: Job) => libraryStatus(job);
  const quiet =
    "inline-flex min-h-11 items-center text-xs text-muted-foreground transition-colors hover:text-foreground";

  if (isLoading && !fetchError) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="font-serif text-5xl font-light tracking-tight sm:text-6xl">Library</h1>
        <p className="mt-16 text-sm text-muted-foreground">{fetchError}</p>
        <button type="button" onClick={fetchJobs} className={quiet}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl text-center">
      <h1 className="font-serif text-5xl font-light tracking-tight sm:text-6xl">Library</h1>

      <div className="mt-16 flex justify-center" aria-live="polite" aria-busy={hasActive}>
        <div
          className={`grid w-max max-w-full justify-center gap-x-14 ${
            jobs.length > 1 ? "grid-cols-1 sm:grid-cols-[11rem_11rem]" : "grid-cols-[11rem]"
          }`}
        >
        {jobs.map((job) => {
          const st = statusFor(job);
          const generating = job.status === "processing" || job.status === "queued";
          const canDownload =
            job.job_kind !== "stream" &&
            (job.status === "ready" ||
              Boolean(job.segments?.some((s) => s.status === "ready")));
          const coverClass =
            "flex aspect-[3/4] w-full items-center justify-center bg-foreground/[0.06] px-4 text-center";
          return (
            <article
              key={job.id}
              className="row-span-4 grid w-44 grid-rows-subgrid text-center"
            >
              {canOpen(job) ? (
                <Link
                  href={playerHref(job)}
                  aria-label={`${openLabel(job)} ${job.book_title}`}
                  className={coverClass}
                >
                  <span className="font-serif text-xl font-light leading-snug text-foreground">
                    {job.book_title}
                  </span>
                </Link>
              ) : (
                <div className={coverClass}>
                  <span className="font-serif text-xl font-light leading-snug text-foreground">
                    {job.book_title}
                  </span>
                </div>
              )}

              <div className="pt-4">
                {generating ? (
                  <>
                    <ProgressLine
                      value={job.progress}
                      label={`${job.book_title} generation progress`}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {job.progress}%{progressSuffix(job)}
                    </p>
                  </>
                ) : st.id !== "ready" ? (
                  <p className="text-xs text-muted-foreground">{st.label}</p>
                ) : null}
                {job.status === "failed" && job.error_message ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {userFriendlyError(job.error_message)}
                  </p>
                ) : null}
                {job.status === "ready" && job.warning ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {userFriendlyError(job.warning)}
                  </p>
                ) : null}
                {notices[job.id] ? (
                  <p className="mt-1 text-xs text-muted-foreground" role="status">
                    {notices[job.id]}
                  </p>
                ) : null}
              </div>

              <p className="truncate pt-2 text-xs text-muted-foreground">
                {job.voice_name || "\u00a0"}
              </p>

              <div className="flex flex-wrap items-center justify-center gap-x-3 pb-14">
                <EditableBookTitle
                  jobId={job.id}
                  title={job.book_title}
                  onRenamed={(title) =>
                    setJobs((prev) =>
                      prev.map((j) => (j.id === job.id ? { ...j, book_title: title } : j))
                    )
                  }
                  inputClassName="text-center text-sm"
                >
                  <span className="sr-only">{job.book_title}</span>
                </EditableBookTitle>
                {generating ? (
                  <button
                    type="button"
                    onClick={(e) => handleCancel(e, job.id)}
                    className={quiet}
                    aria-label={`Cancel ${job.book_title}`}
                  >
                    Cancel
                  </button>
                ) : null}
                {job.status === "failed" ? (
                  <button
                    type="button"
                    onClick={(e) => handleRetry(e, job)}
                    className={quiet}
                    aria-label={`Retry ${job.book_title}`}
                  >
                    Retry
                  </button>
                ) : null}
                {canDownload ? (
                  <button
                    type="button"
                    onClick={(e) => handleDownload(e, job)}
                    className={quiet}
                    aria-label={`Download ${job.book_title}`}
                  >
                    Download
                  </button>
                ) : null}
                {!generating ? (
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, job.id)}
                    className={quiet}
                    aria-label={`Delete ${job.book_title}`}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        </div>
      </div>

      {jobs.length === 0 && !isLoading ? (
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mt-20 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          New audiobook
        </button>
      ) : null}
    </div>
  );
}
