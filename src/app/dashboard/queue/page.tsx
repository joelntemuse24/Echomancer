"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Play, Clock, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Job } from "@/lib/supabase/types";

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
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "processing":
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case "failed":
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      case "queued":
      default:
        return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: Job["status"]) => {
    switch (status) {
      case "ready":
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">Ready</Badge>;
      case "processing":
        return <Badge className="bg-primary/10 text-primary border-primary/20">Processing</Badge>;
      case "failed":
        return <Badge className="bg-destructive/10 text-destructive border-destructive/20">Failed</Badge>;
      case "queued":
      default:
        return <Badge variant="outline">Queued</Badge>;
    }
  };

  const handlePlay = (jobId: string) => {
    router.push(`/dashboard/player/${jobId}`);
  };

  const handleDownload = async (job: Job) => {
    if (!job.audio_storage_path) return;
    // Construct Supabase Storage public URL
    const supabase = createClient();
    const { data } = supabase.storage.from("audiobooks").getPublicUrl(job.audio_storage_path);
    if (data?.publicUrl) {
      window.open(data.publicUrl, "_blank");
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Audiobook Queue</h1>
        <p className="text-muted-foreground">
          Track your audiobook generation progress and download completed files.
          Updates appear in real-time.
        </p>
      </div>

      {/* Desktop Table View */}
      <Card className="bg-card border-border hidden md:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Book Title</TableHead>
                <TableHead>Voice</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {getStatusIcon(job.status)}
                      <span>{job.book_title}</span>
                    </div>
                  </TableCell>
                  <TableCell>{job.voice_name}</TableCell>
                  <TableCell>{getStatusBadge(job.status)}</TableCell>
                  <TableCell>
                    <div className="space-y-2 min-w-[120px]">
                      <Progress value={job.progress} className="h-2" />
                      <span className="text-xs text-muted-foreground">{job.progress}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(job.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      {job.status === "ready" && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => handlePlay(job.id)} className="gap-2">
                            <Play className="w-4 h-4" />
                            Play
                          </Button>
                          <Button size="sm" onClick={() => handleDownload(job)} className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground">
                            <Download className="w-4 h-4" />
                            Download
                          </Button>
                        </>
                      )}
                      {job.status === "processing" && (
                        <Button size="sm" variant="outline" disabled>Processing...</Button>
                      )}
                      {job.status === "queued" && (
                        <Button size="sm" variant="outline" disabled>In Queue</Button>
                      )}
                      {job.status === "failed" && (
                        <span className="text-xs text-destructive">{job.error || "Generation failed"}</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
            </CardContent>
          </Card>
        ))}
      </div>

      {jobs.length === 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-12">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto">
                <Clock className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">No audiobooks in queue</h3>
                <p className="text-muted-foreground">Create your first audiobook to see it here</p>
              </div>
              <Button onClick={() => router.push("/dashboard")} className="mt-4">
                Create Audiobook
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
