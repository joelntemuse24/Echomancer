"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Play, Clock, CheckCircle2, Loader2, AlertCircle, XCircle, MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/supabase/types";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function QueuePage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // Initial fetch
    async function fetchJobs() {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false });

      if (!error && data) {
        setJobs(data as Job[]);
      }
      setIsLoading(false);
    }

    fetchJobs();

    // Subscribe to realtime changes on the jobs table
    const channel = supabase
      .channel("jobs-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs" },
        (payload) => {
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

  const getStatusIcon = (status: Job["status"]) => {
    switch (status) {
      case "ready":
        return <CheckCircle2 className="w-4 h-4 text-[#7a8f7e]" />;
      case "processing":
        return <Loader2 className="w-4 h-4 text-[#D97757] animate-spin" />;
      case "failed":
        return <AlertCircle className="w-4 h-4 text-[#a65d4d]" />;
      case "queued":
      default:
        return <Clock className="w-4 h-4 text-[#a39b8f]" />;
    }
  };

  const getStatusBadge = (status: Job["status"]) => {
    switch (status) {
      case "ready":
        return <Badge variant="sage">Ready</Badge>;
      case "processing":
        return <Badge variant="copper">Processing</Badge>;
      case "failed":
        return <Badge variant="brick">Failed</Badge>;
      case "queued":
      default:
        return <Badge variant="taupe">Queued</Badge>;
    }
  };

  const handlePlay = (jobId: string) => {
    if (!jobId) {
      toast.error("Invalid job ID");
      return;
    }
    router.push(`/dashboard/player/${jobId}`);
  };

  const handleDownload = async (job: Job) => {
    if (!job.audio_storage_path) {
      toast.error("No audio file available for download");
      return;
    }
    try {
      const supabase = createClient();
      const { data } = supabase.storage.from("audiobooks").getPublicUrl(job.audio_storage_path);
      
      if (!data?.publicUrl) {
        toast.error("Could not generate download URL");
        return;
      }

      toast.info("Preparing download...");

      const safeTitle = job.book_title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || "audiobook";
      const filename = `${safeTitle}.mp3`;
      
      // Append ?download=filename to the Supabase URL. 
      // This tells the Supabase CDN to set Content-Disposition: attachment,
      // which forces the browser to download the file directly without needing client-side fetch (bypassing CORS).
      const downloadUrl = `${data.publicUrl}?download=${encodeURIComponent(filename)}`;
      
      // First, try to fetch the final concatenated file
      try {
        const response = await fetch(downloadUrl, { method: 'HEAD' });
        if (response.ok) {
          // File exists, proceed with download
          const a = document.createElement("a");
          a.style.display = 'none';
          a.href = downloadUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          toast.success("Download started");
          return;
        }
      } catch (e) {
        console.warn("Final concatenated file not found, falling back to first chunk");
      }

      // Fallback: try to download the first available chunk if the final file is missing
      try {
        const { data: chunks, error: chunksError } = await supabase
          .from("job_checkpoints")
          .select("audio_path")
          .eq("job_id", job.id)
          .order("section_index", { ascending: true })
          .limit(1);

        if (chunksError) {
          console.warn("Could not fetch chunks (table may not exist):", chunksError.message);
          toast.error("Final audio file not found and no chunks available");
          return;
        }

        if (!chunks || chunks.length === 0) {
          toast.error("No audio chunks available for download");
          return;
        }

        const firstChunk = chunks[0];
        if (!firstChunk?.audio_path) {
          toast.error("Invalid audio chunk data");
          return;
        }
        const firstChunkPath = firstChunk.audio_path;
        const { data: chunkData } = supabase.storage.from("audiobooks").getPublicUrl(firstChunkPath);
        
        if (!chunkData?.publicUrl) {
          toast.error("Could not generate download URL for audio chunk");
          return;
        }

        const chunkFilename = `${safeTitle}_part1.mp3`;
        const chunkDownloadUrl = `${chunkData.publicUrl}?download=${encodeURIComponent(chunkFilename)}`;
        
        const a = document.createElement("a");
        a.style.display = 'none';
        a.href = chunkDownloadUrl;
        a.download = chunkFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        toast.success("Download started (first available chunk)");
      } catch (chunkError) {
        console.error("Chunk fallback failed:", chunkError);
        toast.error("Final audio file not available and chunk fallback failed");
      }
    } catch (error) {
      console.error("Download failed:", error);
      toast.error("Failed to download audiobook. Please try again.");
    }
  };

  const handleCancel = async (jobId: string) => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to cancel job");
      }
      
      toast.success("Job cancelled successfully");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to cancel job");
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[#D97757]" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">Audiobook Queue</h1>
        <p className="text-[#a39b8f]">
          Track your audiobook generation progress and download completed files.
          Updates appear in real-time.
        </p>
      </div>

      {/* Desktop Table View */}
      <Card className="hidden md:block bg-card border-border overflow-hidden">
        <CardContent className="p-0">
          <div className="w-full overflow-x-auto">
            <Table className="w-full table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[35%] min-w-[200px]">Book Title</TableHead>
                  <TableHead className="w-[15%] min-w-[100px]">Voice</TableHead>
                  <TableHead className="w-[12%] min-w-[100px]">Status</TableHead>
                  <TableHead className="w-[15%] min-w-[120px]">Progress</TableHead>
                  <TableHead className="w-[15%] min-w-[150px]">Created</TableHead>
                  <TableHead className="w-[8%] min-w-[80px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id} className="group">
                  <TableCell className="max-w-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="shrink-0">{getStatusIcon(job.status)}</div>
                      <span className="font-medium truncate" title={job.book_title}>
                        {job.book_title}
                      </span>
                      {(job.status === 'processing' || job.status === 'queued') && (
                        <Button 
                          size="sm" 
                          variant="destructive" 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancel(job.id);
                          }}
                          className="ml-2 h-7 px-2 text-xs shrink-0"
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="truncate">{job.voice_name}</TableCell>
                  <TableCell>{getStatusBadge(job.status)}</TableCell>
                  <TableCell>
                    <div className="space-y-1 min-w-[100px]">
                      <Progress value={job.progress} className="h-2" />
                      <span className="text-xs text-muted-foreground">{job.progress}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {formatDate(job.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="icon"
                          className="h-8 w-8"
                        >
                          <span className="sr-only">Open menu</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={4}>
                        {job.status === "ready" && (
                          <>
                            <DropdownMenuItem 
                              onClick={() => handlePlay(job.id)} 
                              className="gap-2 cursor-pointer"
                            >
                              <Play className="w-4 h-4" />
                              Play
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => handleDownload(job)} 
                              className="gap-2 cursor-pointer text-primary focus:text-primary"
                            >
                              <Download className="w-4 h-4" />
                              Download
                            </DropdownMenuItem>
                          </>
                        )}
                        {(job.status === "processing" || job.status === "queued") && (
                          <>
                            <DropdownMenuItem disabled className="cursor-default">
                              {job.status === "processing" ? "Processing..." : "In Queue"}
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => handleCancel(job.id)} 
                              className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                            >
                              <XCircle className="w-4 h-4" />
                              Cancel
                            </DropdownMenuItem>
                          </>
                        )}
                        {job.status === "failed" && (
                          <DropdownMenuItem 
                            disabled 
                            className="text-destructive max-w-[250px] whitespace-normal cursor-default"
                          >
                            {job.error || "Generation failed"}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>

      {/* Mobile Card View */}
      <div className="space-y-4 md:hidden">
        {jobs.map((job) => (
          <Card key={job.id} className="bg-card border-border">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(job.status)}
                    <h4 className="font-semibold line-clamp-1">{job.book_title}</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">{job.voice_name}</p>
                </div>
                {getStatusBadge(job.status)}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Progress</span>
                  <span>{job.progress}%</span>
                </div>
                <Progress value={job.progress} className="h-2" />
              </div>
              <div className="text-xs text-muted-foreground">Created: {formatDate(job.created_at)}</div>
              {job.status === "ready" && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => handlePlay(job.id)} className="flex-1 gap-2">
                    <Play className="w-4 h-4" />Play
                  </Button>
                  <Button size="sm" onClick={() => handleDownload(job)} className="flex-1 gap-2 bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Download className="w-4 h-4" />Download
                  </Button>
                </div>
              )}
              {job.status === "processing" && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled className="flex-1">Processing...</Button>
                  <Button size="sm" variant="destructive" onClick={() => handleCancel(job.id)} className="flex-1 gap-2">
                    <XCircle className="w-4 h-4" />Cancel
                  </Button>
                </div>
              )}
              {job.status === "queued" && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled className="flex-1">In Queue</Button>
                  <Button size="sm" variant="destructive" onClick={() => handleCancel(job.id)} className="flex-1 gap-2">
                    <XCircle className="w-4 h-4" />Cancel
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {jobs.length === 0 && (
        <Card className="bg-[#1a1a1a] border-[#333]">
          <CardContent className="p-12">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-[#242424] rounded-full flex items-center justify-center mx-auto">
                <Clock className="w-8 h-8 text-[#a39b8f]" />
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-semibold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">No audiobooks in queue</h3>
                <p className="text-[#a39b8f]">Create your first audiobook to see it here</p>
              </div>
              <Button onClick={() => router.push("/dashboard")} className="mt-4 bg-[#D97757] hover:bg-[#E8957A] text-[#0d0d0d]">
                Create Audiobook
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
