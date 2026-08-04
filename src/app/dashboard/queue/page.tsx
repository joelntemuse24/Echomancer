"use client";

import { Button } from "@/components/ui/button";
import {
  Download,
  Loader2,
  AlertCircle,
  ArrowRight,
  RotateCcw,
  Trash2,
  XCircle,
  Headphones,
  Plus,
} from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion } from "motion/react";
import { userFriendlyError } from "@/lib/errors-ui";
import { libraryStatus, kindLabel } from "@/lib/ux-copy";

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
  created_at: string;
  updated_at: string;
  job_kind?: string | null;
  generation_mode?: string | null;
  tts_provider?: string | null;
  segments?: Array<{ index: number; path: string; status: string }> | null;
  price_estimate_eur?: number | null;
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

  // Initial fetch — shows the full-page loader
  const fetchJobs = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const response = await fetch("/api/jobs");
      if (!response.ok) throw new Error("Failed to fetch jobs");
      const data = await response.json();
      setJobs(data.jobs || []);
      setFetchError(null);
    } catch (error) {
      console.error("Failed to fetch jobs:", error);
      setFetchError(error instanceof Error ? error.message : "Failed to load jobs");
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
    if (job.status === "processing" || job.status === "queued") return "View progress";
    return "Open";
  };

  const handleDownload = async (e: React.MouseEvent, job: Job) => {
    e.stopPropagation();
    if (job.status !== "ready" && !job.segments?.some((s) => s.status === "ready")) {
      toast.error("Audio isn't ready to download yet");
      return;
    }
    try {
      const { downloadFromUrl, audiobookFilename } = await import(
        "@/lib/download-client"
      );
      toast.message("Preparing full audiobook…");
      await downloadFromUrl(
        `/api/jobs/${job.id}/download`,
        audiobookFilename(job.book_title)
      );
      toast.success("Download started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download");
    }
  };

  const handleDelete = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    if (!confirm("Delete this audiobook? This cannot be undone.")) return;
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete");
      }
      setJobs(prev => prev.filter(job => job.id !== jobId));
      toast.success("Deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete");
    }
  };

  const handleCancel = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    try {
      const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to cancel");
      }
      refreshJobs();
      toast.success("Job cancelled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to cancel");
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
        throw new Error(data.error || "Failed to retry");
      }

      refreshJobs();
      toast.success("Retrying...");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to retry");
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString();
  };

  const progressSuffix = (job: Job): string => {
    const parts: string[] = [];
    if (job.elapsed_label) parts.push(`${job.elapsed_label} elapsed`);
    if (job.eta_label) parts.push(`${job.eta_label} left`);
    else if (job.status === "queued" && job.progress === 0) parts.push("starting…");
    return parts.length ? ` · ${parts.join(" · ")}` : "";
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
      <div className="max-w-4xl mx-auto space-y-8 pb-12">
        <div>
          <h1 className="text-5xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Library</h1>
          <p className="text-muted-foreground mt-2 font-serif">Your generated audiobooks</p>
        </div>
        <div className="text-center py-24 border border-dashed border-destructive/30 rounded-sm">
          <AlertCircle className="w-8 h-8 mx-auto mb-3 text-destructive" />
          <p className="text-destructive mb-2">{fetchError}</p>
          <Button variant="outline" onClick={fetchJobs}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-5xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Library</h1>
        <p className="text-muted-foreground mt-2 font-serif">Your generated audiobooks</p>
      </div>

      <div className="grid gap-4" aria-live="polite" aria-busy={hasActive}>
        {jobs.map((job, idx) => (
          <motion.div
            key={job.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.05 }}
            className={`p-6 rounded-sm border transition-all ${
              canOpen(job)
                ? "border-border/50 hover:border-foreground/30 bg-card group"
                : "border-border/20 bg-accent/20"
            }`}
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-3 flex-wrap">
                  {canOpen(job) ? (
                    <Link
                      href={playerHref(job)}
                      className="font-medium text-lg font-serif hover:text-[#D97757] transition-colors truncate max-w-full"
                    >
                      {job.book_title}
                    </Link>
                  ) : (
                    <h3 className="font-medium text-lg font-serif">
                      {job.book_title}
                    </h3>
                  )}
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
                        <span className="text-xs px-2 py-0.5 rounded-sm bg-[#D97757]/15 text-[#D97757]">
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
                        <span className="text-xs px-2 py-0.5 rounded-sm bg-[#D97757]/10 text-[#D97757]">
                          {st.label}
                        </span>
                      );
                    }
                    return (
                      <span className="text-xs px-2 py-0.5 rounded-sm bg-accent text-muted-foreground">
                        {st.label}
                      </span>
                    );
                  })()}
                  {kindLabel(job.job_kind) && statusFor(job).id !== "listening" && (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {kindLabel(job.job_kind)}
                    </span>
                  )}
                </div>
                {job.status === "failed" && job.error_message && (
                  <p className="text-xs text-muted-foreground mt-1">{userFriendlyError(job.error_message)}</p>
                )}
                <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                  <span>Voice: {job.voice_name}</span>
                  <span className="w-1 h-1 rounded-full bg-border" />
                  <span>{formatDate(job.created_at)}</span>
                  {job.price_estimate_eur != null && (
                    <>
                      <span className="w-1 h-1 rounded-full bg-border" />
                      <span>Est. €{Number(job.price_estimate_eur).toFixed(2)}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-4">
                {job.status === "processing" || job.status === "queued" ? (
                  <div className="flex items-center gap-4 w-full md:w-auto">
                    <Link
                      href={playerHref(job)}
                      className="flex flex-col items-end gap-2 flex-1 md:w-48 min-w-0"
                      aria-label={`View progress for ${job.book_title}`}
                    >
                      <div className="flex items-center justify-between w-full text-xs">
                        <span className="text-muted-foreground">
                          {statusFor(job).label}
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
                      <span className="text-[10px] text-[#D97757] self-start">
                        {openLabel(job)} →
                      </span>
                    </Link>
                    <button
                      type="button"
                      onClick={(e) => handleCancel(e, job.id)}
                      className="text-sm text-muted-foreground hover:text-destructive transition-colors p-2"
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
                        className="flex items-center gap-2 text-sm text-foreground hover:text-foreground/80 transition-colors"
                        aria-label={`Retry ${job.book_title}`}
                      >
                        <RotateCcw aria-hidden="true" className="w-4 h-4" />
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, job.id)}
                      className="text-sm text-muted-foreground hover:text-destructive transition-colors p-2"
                      aria-label={`Delete ${job.book_title}`}
                    >
                      <Trash2 aria-hidden="true" className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-4 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                    {job.job_kind !== "stream" && (
                      <button
                        type="button"
                        onClick={(e) => handleDownload(e, job)}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors p-2"
                        aria-label={`Download ${job.book_title}`}
                      >
                        <Download aria-hidden="true" className="w-4 h-4" />
                      </button>
                    )}
                    {canPlay(job) && (
                      <Link
                        href={playerHref(job)}
                        className="flex items-center gap-2 text-sm font-medium rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
                        aria-label={`Listen to ${job.book_title}`}
                      >
                        Listen
                        <ArrowRight aria-hidden="true" className="w-4 h-4" />
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, job.id)}
                      className="text-sm text-muted-foreground hover:text-destructive transition-colors p-2"
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
          <div className="text-center py-24 border border-dashed border-border/50 rounded-sm">
            <Headphones className="w-10 h-10 mx-auto mb-4 text-muted-foreground/40" />
            <p className="text-muted-foreground mb-1">Your library is empty.</p>
            <p className="text-xs text-muted-foreground/70 mb-6">Upload a book and choose a narrator to get started.</p>
            <Button
              variant="outline"
              onClick={() => router.push('/')}
            >
              <Plus className="w-4 h-4 mr-2" />
              New audiobook
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
