"use client";

import { Button } from "@/components/ui/button";
import { Download, Play, CheckCircle2, Loader2, AlertCircle, ArrowRight, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion } from "motion/react";
import { userFriendlyError } from "@/lib/errors-ui";

interface Job {
  id: string;
  book_title: string;
  voice_name: string | null;
  pdf_storage_path: string;
  voice_storage_path: string | null;
  video_id: string | null;
  start_time: number;
  end_time: number;
  status: "queued" | "processing" | "ready" | "failed";
  progress: number;
  current_section: number;
  total_sections: number;
  audio_storage_path: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
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

  const handlePlay = (jobId: string) => {
    if (!jobId) {
      toast.error("Invalid job ID");
      return;
    }
    router.push(`/dashboard/player/${jobId}`);
  };

  const handleDownload = async (e: React.MouseEvent, job: Job) => {
    e.stopPropagation();
    if (!job.audio_storage_path) {
      toast.error("No audio file available");
      return;
    }
    try {
      const safeTitle = job.book_title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || "audiobook";
      const filename = `${safeTitle}.mp3`;
      const downloadUrl = `/api/storage/${job.audio_storage_path}?download=${encodeURIComponent(filename)}`;
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast.success("Download started");
    } catch (error) {
      toast.error("Failed to download");
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

  const estimateTimeRemaining = (job: Job): string | null => {
    if (job.status !== "processing" || job.progress < 10) return null;
    const elapsed = (Date.now() - new Date(job.updated_at).getTime()) / 1000;
    const progressFraction = Math.max((job.progress - 5) / 95, 0.01);
    const totalEstimated = elapsed / progressFraction;
    const remaining = Math.max(0, totalEstimated - elapsed);
    if (remaining < 60) return `~${Math.round(remaining)}s left`;
    return `~${Math.round(remaining / 60)}m left`;
  };

  if (isLoading && !fetchError) {
    return (
      <div className="max-w-4xl mx-auto space-y-8 pb-12">
        <div>
          <h1 className="text-5xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Library</h1>
          <p className="text-muted-foreground mt-2 font-serif">Your generated audiobooks</p>
        </div>
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-sm border border-border/20 bg-accent/20 animate-pulse">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-3 flex-1">
                  <div className="h-5 w-48 bg-accent rounded" />
                  <div className="h-3 w-32 bg-accent rounded" />
                </div>
                <div className="h-8 w-20 bg-accent rounded" />
              </div>
            </div>
          ))}
        </div>
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

      {jobs.length === 0 && (
        <div className="text-center py-24 border border-dashed border-border/30 rounded-sm">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-accent flex items-center justify-center">
            <Play className="w-5 h-5 text-muted-foreground" />
          </div>
          <p className="text-muted-foreground font-serif text-lg mb-2">No audiobooks yet</p>
          <p className="text-sm text-muted-foreground/70 mb-6">Upload a PDF and choose a voice to create your first audiobook.</p>
          <Button
            variant="outline"
            onClick={() => router.push("/")}
            className="gap-2"
          >
            Create Audiobook
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      )}

      <div className="grid gap-4">
        {jobs.map((job, idx) => (
          <motion.div
            key={job.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.05 }}
            onClick={() => job.status === "ready" ? handlePlay(job.id) : undefined}
            className={`p-6 rounded-sm border transition-all ${
              job.status === "ready"
                ? "border-border/50 hover:border-foreground/30 bg-card cursor-pointer group"
                : "border-border/20 bg-accent/20"
            }`}
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <h3 className="font-medium text-lg font-serif">
                    {job.book_title}
                  </h3>
                  {job.status === "ready" && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground">
                      Ready
                    </span>
                  )}
                  {job.status === "failed" && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive border border-destructive/20 flex items-center gap-1.5">
                      <AlertCircle className="w-3 h-3" />
                      Failed
                    </span>
                  )}
                </div>
                {job.status === "failed" && job.error_message && (
                  <p className="text-xs text-muted-foreground mt-1">{userFriendlyError(job.error_message)}</p>
                )}
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span>Voice: {job.voice_name}</span>
                  <span className="w-1 h-1 rounded-full bg-border" />
                  <span>{formatDate(job.created_at)}</span>
                </div>
              </div>

              <div className="flex items-center gap-4">
                {job.status === "processing" || job.status === "queued" ? (
                  <div className="flex items-center gap-4 w-full md:w-auto">
                    <div className="flex flex-col items-end gap-2 flex-1 md:w-48">
                      <div className="flex items-center justify-between w-full text-xs">
                        <span className="text-muted-foreground capitalize">{job.status}</span>
                        <span className="font-medium">{job.progress}%{estimateTimeRemaining(job) ? ` · ${estimateTimeRemaining(job)}` : ''}</span>
                      </div>
                      <div className="w-full h-1 bg-accent rounded-full overflow-hidden">
                        <div
                          className="h-full bg-foreground transition-all duration-500 ease-out"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                    </div>
                    <button
                      onClick={(e) => handleCancel(e, job.id)}
                      className="text-sm text-muted-foreground hover:text-destructive transition-colors p-2"
                      title="Cancel"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                ) : job.status === "failed" ? (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={(e) => handleRetry(e, job)}
                      className="flex items-center gap-2 text-sm text-foreground hover:text-foreground/80 transition-colors"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Retry
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, job.id)}
                      className="text-sm text-muted-foreground hover:text-destructive transition-colors p-2"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-4 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => handleDownload(e, job)}
                      className="text-sm text-muted-foreground hover:text-foreground transition-colors p-2"
                      title="Download MP3"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      className="flex items-center gap-2 text-sm font-medium"
                      title="Play"
                    >
                      Listen
                      <ArrowRight className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, job.id)}
                      className="text-sm text-muted-foreground hover:text-destructive transition-colors p-2"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        ))}

        {jobs.length === 0 && !isLoading && (
          <div className="text-center py-24 border border-dashed border-border/50 rounded-sm">
            <p className="text-muted-foreground mb-4">Your library is empty.</p>
            <Button
              variant="outline"
              onClick={() => router.push('/dashboard/voice')}
            >
              Create Audiobook
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
