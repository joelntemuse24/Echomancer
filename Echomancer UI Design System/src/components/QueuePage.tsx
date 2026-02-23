import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { Download, Play, Clock, CheckCircle2, Loader2 } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

interface AudiobookJob {
  id: string;
  bookTitle: string;
  voiceName: string;
  status: "queued" | "processing" | "ready";
  progress: number;
  createdAt: string;
}

interface QueuePageProps {
  onPlayAudiobook: (id: string) => void;
  onDownloadAudiobook: (id: string) => void;
}

const mockJobs: AudiobookJob[] = [
  {
    id: "1",
    bookTitle: "The Great Gatsby.pdf",
    voiceName: "Documentary Narration",
    status: "ready",
    progress: 100,
    createdAt: "2024-12-04 10:30"
  },
  {
    id: "2",
    bookTitle: "Pride and Prejudice.pdf",
    voiceName: "British Accent Narration",
    status: "processing",
    progress: 65,
    createdAt: "2024-12-04 11:15"
  },
  {
    id: "3",
    bookTitle: "1984 by George Orwell.pdf",
    voiceName: "Professional Voice Acting",
    status: "queued",
    progress: 0,
    createdAt: "2024-12-04 11:45"
  },
];

export function QueuePage({ onPlayAudiobook, onDownloadAudiobook }: QueuePageProps) {
  const getStatusIcon = (status: AudiobookJob["status"]) => {
    switch (status) {
      case "ready":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "processing":
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case "queued":
        return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: AudiobookJob["status"]) => {
    switch (status) {
      case "ready":
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">Ready</Badge>;
      case "processing":
        return <Badge className="bg-primary/10 text-primary border-primary/20">Processing</Badge>;
      case "queued":
        return <Badge variant="outline">Queued</Badge>;
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1>Audiobook Queue</h1>
        <p className="text-muted-foreground">
          Track your audiobook generation progress and download completed files
        </p>
      </div>

      {/* Desktop Table View */}
      <Card className="bg-card border-border hidden md:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Book Title</TableHead>
                <TableHead>Voice Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockJobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {getStatusIcon(job.status)}
                      <span>{job.bookTitle}</span>
                    </div>
                  </TableCell>
                  <TableCell>{job.voiceName}</TableCell>
                  <TableCell>{getStatusBadge(job.status)}</TableCell>
                  <TableCell>
                    <div className="space-y-2 min-w-[120px]">
                      <Progress value={job.progress} className="h-2" />
                      <span className="text-xs text-muted-foreground">{job.progress}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {job.createdAt}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      {job.status === "ready" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onPlayAudiobook(job.id)}
                            className="gap-2"
                          >
                            <Play className="w-4 h-4" />
                            Play
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => onDownloadAudiobook(job.id)}
                            className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
                          >
                            <Download className="w-4 h-4" />
                            Download
                          </Button>
                        </>
                      )}
                      {job.status === "processing" && (
                        <Button size="sm" variant="outline" disabled>
                          Processing...
                        </Button>
                      )}
                      {job.status === "queued" && (
                        <Button size="sm" variant="outline" disabled>
                          In Queue
                        </Button>
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
        {mockJobs.map((job) => (
          <Card key={job.id} className="bg-card border-border">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(job.status)}
                    <h4 className="line-clamp-1">{job.bookTitle}</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">{job.voiceName}</p>
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

              <div className="text-xs text-muted-foreground">
                Created: {job.createdAt}
              </div>

              {job.status === "ready" && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPlayAudiobook(job.id)}
                    className="flex-1 gap-2"
                  >
                    <Play className="w-4 h-4" />
                    Play
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => onDownloadAudiobook(job.id)}
                    className="flex-1 gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
                  >
                    <Download className="w-4 h-4" />
                    Download
                  </Button>
                </div>
              )}
              {job.status === "processing" && (
                <Button size="sm" variant="outline" disabled className="w-full">
                  Processing...
                </Button>
              )}
              {job.status === "queued" && (
                <Button size="sm" variant="outline" disabled className="w-full">
                  In Queue
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {mockJobs.length === 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-12">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto">
                <Clock className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="space-y-2">
                <h3>No audiobooks in queue</h3>
                <p className="text-muted-foreground">
                  Create your first audiobook to see it here
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
