"use client";

import { Button } from "@/components/ui/button";
import { Download, Play, Clock, CheckCircle2, Loader2, AlertCircle, ArrowRight, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/supabase/types";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { userFriendlyError } from "@/lib/errors-ui";

export default function QueuePage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const realtimeReceived = useRef(false);

  useEffect(() => {
    const supabase = createClient();

    async function fetchJobs() {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false });

      // Skip stale fetch if realtime already delivered fresher data
      if (!error && data && !realtimeReceived.current) {
        setJobs(data as Job[]);
      }
      setIsLoading(false);
    }

    fetchJobs();

    const channel = supabase
      .channel("jobs-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs" },
        (payload) => {
          realtimeReceived.current = true;
          if (payload.eventType === "INSERT") {
            setJobs((prev) => [payload.new as Job, ...prev]);
          } else if (payload.eventType === "UPDATE") {
            setJobs((prev) =>
              prev.map((job) => (job.id === payload.new.id ? (payload.new as Job) : job))
            );
          } else if (payload.eventType === "DELETE") {
            setJobs((prev) => prev.filter((job) => job.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

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
      const supabase = createClient();
      const { data } = supabase.storage.from("audiobooks").getPublicUrl(job.audio_storage_path);
      if (!data?.publicUrl) {
        toast.error("Could not generate download URL");
        return;
      }
      const safeTitle = job.book_title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || "audiobook";
      const filename = `${safeTitle}.mp3`;
      const downloadUrl = `${data.publicUrl}?download=${encodeURIComponent(filename)}`;
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = filename;
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast.success("Download started");
    } catch (error) {
      toast.error("Failed to download");
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
      toast.success("Cancelled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to cancel");
    }
  };

  const handleDelete = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete");
      }
      toast.success("Deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete");
    }
  };

  const handleRetry = async (e: React.MouseEvent, job: Job) => {
    e.stopPropagation();
    try {
      const deleteRes = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (!deleteRes.ok) {
        const data = await deleteRes.json();
        throw new Error(data.error || "Failed to delete old job");
      }

      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfStoragePath: job.pdf_storage_path,
          bookTitle: job.book_title,
          voiceStoragePath: job.voice_storage_path,
          voiceName: job.voice_name,
          videoId: job.video_id || undefined,
          startTime: job.start_time,
          endTime: job.end_time,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to retry");
      }

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
    // Progress goes from ~5% (start) to 100%. Use 5% as baseline.
    const progressFraction = Math.max((job.progress - 5) / 95, 0.01);
    const totalEstimated = elapsed / progressFraction;
    const remaining = Math.max(0, totalEstimated - elapsed);
    if (remaining < 60) return `~${Math.round(remaining)}s left`;
    return `~${Math.round(remaining / 60)}m left`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-5xl tracking-tight font-serif" style={{ fontWeight: 300 }}>Library</h1>
        <p className="text-muted-foreground mt-2 font-serif">Your generated audiobooks</p>
      </div>

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
                {job.status === "failed" && job.error && (
                  <p className="text-xs text-muted-foreground mt-1">{userFriendlyError(job.error)}</p>
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
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    >
                      Cancel
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
                  <div className="flex items-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity">
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
