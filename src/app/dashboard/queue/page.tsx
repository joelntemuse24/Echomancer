"use client";

import {
  Download,
  Loader2,
  AlertCircle,
  ArrowRight,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { userFriendlyError } from "@/lib/errors-ui";
import { WaitMark } from "@/components/wait-mark";
import { EditableBookTitle } from "@/components/editable-book-title";
import { libraryStatus, UX, WAIT } from "@/lib/ux-copy";
import {
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "@/lib/download-client";

/** Two lines on a phone. One truncated line from the md breakpoint up. */
const bookTitleClass =
  "min-w-0 max-w-full basis-full break-words font-medium text-lg font-serif leading-snug max-md:line-clamp-2 md:basis-auto md:truncate";

interface Job {
  id: string;
  book_title: string;
  voice_name: string | null;
  status: "queued" | "waiting" | "processing" | "ready" | "failed" | "cancelled";
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
  const hasActive = jobs.some(
    (j) => j.status === "processing" || j.status === "queued" || j.status === "waiting"
  );
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
    canPlay(job) ||
    job.status === "processing" ||
    job.status === "queued" ||
    job.status === "waiting";

  const openLabel = (job: Job): string => {
    if (canPlay(job)) return "Listen";
    if (job.status === "processing" || job.status === "queued" || job.status === "waiting") {
      return "Progress";
    }
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

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString();
  };

  const progressSuffix = (job: Job): string => {
    if (!job.eta_label) return "";
    return ` · ${job.eta_label} left`;
  };

  const statusFor = (job: Job) => libraryStatus(job);

  if (isLoading && !fetchError) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fetchError) {
    return (
        <div className="mx-auto w-full min-w-0 max-w-3xl space-y-16 pb-16 font-sans">
        <div>
          <h1 className="text-5xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Library</h1>
        </div>
        <div className="text-center py-24 space-y-3">
          <p className="text-sm text-destructive">{fetchError}</p>
          <button
            type="button"
            onClick={fetchJobs}
            className="tap text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
        <div className="mx-auto w-full min-w-0 max-w-3xl space-y-16 pb-16 font-sans">
      <div>
        <h1 className="text-5xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Library</h1>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4" aria-live="polite" aria-busy={hasActive}>
        {jobs.map((job, idx) => (
          <motion.div
            key={job.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.05 }}
            className={`w-full min-w-0 p-6 rounded-sm border transition-all ${
              canOpen(job)
                ? "border-border/50 hover:border-foreground/30 bg-card group"
                : "border-border/20 bg-accent/20"
            }`}
          >
            <div className="flex w-full min-w-0 flex-col justify-between gap-6 md:flex-row md:items-center">
              <div className="w-full min-w-0 flex-1 space-y-1">
                <div className="flex w-full min-w-0 flex-wrap items-center gap-3">
                  <EditableBookTitle
                    jobId={job.id}
                    title={job.book_title}
                    onRenamed={(title) =>
                      setJobs((prev) =>
                        prev.map((j) => (j.id === job.id ? { ...j, book_title: title } : j))
                      )
                    }
                    inputClassName="text-lg font-serif leading-snug"
                    buttonClassName="md:-ml-2 md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:focus-visible:pointer-events-auto md:focus-visible:opacity-100"
                  >
                    {canOpen(job) ? (
                      <Link
                        href={playerHref(job)}
                        className={`${bookTitleClass} transition-colors hover:text-foreground/70`}
                      >
                        {job.book_title}
                      </Link>
                    ) : (
                      <h3 className={bookTitleClass}>{job.book_title}</h3>
                    )}
                  </EditableBookTitle>
                  {(() => {
                    const st = statusFor(job);
                    if (st.id === "ready") {
                      return (
                        <span className="text-xs px-2 py-0.5 rounded-sm bg-accent text-muted-foreground">
                          {st.label}
                        </span>
                      );
                    }
                    if (st.id === "ready_to_play") {
                      return (
                        <span className="text-xs px-2 py-0.5 rounded-sm bg-accent text-muted-foreground">
                          {st.label}
                        </span>
                      );
                    }
                    if (st.id === "failed") {
                      return (
                        <span className="text-xs px-2 py-0.5 rounded-sm bg-destructive/10 text-destructive border border-destructive/20 flex items-center gap-1.5">
                          <AlertCircle className="w-3 h-3" />
                          {st.label}
                        </span>
                      );
                    }
                    if (st.id === "listening") {
                      return (
                        <span className="text-xs px-2 py-0.5 rounded-sm bg-accent text-muted-foreground">
                          {st.label}
                        </span>
                      );
                    }
                    // Plain generating: the progress bar beside the title
                    // already carries the state, so no second label.
                    if (st.id === "generating") return null;
                    return (
                      <span className="text-xs px-2 py-0.5 rounded-sm bg-accent text-muted-foreground">
                        {st.label}
                      </span>
                    );
                  })()}
                </div>
                {job.status === "failed" && job.error_message && (
                  <p className="text-xs text-muted-foreground mt-1">{userFriendlyError(job.error_message)}</p>
                )}
                {job.status === "ready" && job.warning && (
                  <p className="text-xs text-muted-foreground mt-1">{userFriendlyError(job.warning)}</p>
                )}
                {notices[job.id] && (
                  <p className="text-xs text-muted-foreground mt-1" role="status">
                    {notices[job.id]}
                  </p>
                )}
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>{job.voice_name}</span>
                  <span className="w-1 h-1 rounded-full bg-border" />
                  <span>{formatDate(job.created_at)}</span>
                </div>
              </div>

              <div className="flex w-full min-w-0 flex-wrap items-center gap-4 md:w-auto">
                {job.status === "processing" ||
                job.status === "queued" ||
                job.status === "waiting" ? (
                  <div className="flex items-center gap-4 w-full md:w-auto">
                    <Link
                      href={playerHref(job)}
                      className="flex flex-col items-end gap-2 flex-1 md:w-48 min-w-0"
                      aria-label={`Progress for ${job.book_title}`}
                    >
                      <div className="flex items-center justify-between w-full text-xs">
                        <span className="text-muted-foreground">
                          {job.job_kind === "stream" ? (
                            statusFor(job).label
                          ) : (
                            <WaitMark phrases={WAIT.generating} />
                          )}
                        </span>
                        <span className="font-medium">
                          {job.progress}%{progressSuffix(job)}
                        </span>
                      </div>
                      <div
                        className="w-full h-1 bg-accent rounded-full overflow-hidden"
                        role="progressbar"
                        aria-label={`${job.book_title} generation progress`}
                        aria-valuenow={job.progress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div
                          className="h-full bg-foreground transition-all duration-500 ease-out"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground self-start">
                        {openLabel(job)} →
                      </span>
                    </Link>
                    <button
                      type="button"
                      onClick={(e) => handleCancel(e, job.id)}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Cancel ${job.book_title}`}
                    >
                      <XCircle aria-hidden="true" className="w-4 h-4" />
                    </button>
                  </div>
                ) : job.status === "failed" || job.status === "cancelled" ? (
                  <div className="flex items-center gap-3">
                    {/* A cancelled job was stopped on purpose, so it is not offered a retry. */}
                    {job.status === "failed" && (
                      <button
                        type="button"
                        onClick={(e) => handleRetry(e, job)}
                        className="tap flex items-center gap-2 text-sm text-foreground hover:text-foreground/80 transition-colors"
                        aria-label={`Retry ${job.book_title}`}
                      >
                        <RotateCcw aria-hidden="true" className="w-4 h-4" />
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, job.id)}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Delete ${job.book_title}`}
                    >
                      <Trash2 aria-hidden="true" className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex max-w-full flex-wrap items-center gap-4 transition-opacity md:opacity-40 md:group-hover:opacity-100 md:focus-within:opacity-100">
                    {job.job_kind !== "stream" && (
                      <button
                        type="button"
                        onClick={(e) => handleDownload(e, job)}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={`Download ${job.book_title}`}
                      >
                        <Download aria-hidden="true" className="w-4 h-4" />
                      </button>
                    )}
                    {canPlay(job) && (
                      <Link
                        href={playerHref(job)}
                        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium rounded-sm"
                        aria-label={`Listen to ${job.book_title}`}
                      >
                        Listen
                        <ArrowRight aria-hidden="true" className="w-4 h-4" />
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, job.id)}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Delete ${job.book_title}`}
                    >
                      <Trash2 aria-hidden="true" className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        ))}

        {jobs.length === 0 && !isLoading && (
          <div className="text-center py-24">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="tap text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              New audiobook
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
