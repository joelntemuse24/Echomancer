import { NextRequest } from "next/server";
import { queryOne } from "@/lib/turso";

interface JobRow {
  id: string;
  status: string;
  progress: number | null;
  current_section: number | null;
  total_sections: number | null;
  audio_storage_path: string | null;
  duration_seconds: number | null;
  error_message: string | null;
}

/**
 * SSE endpoint for real-time job progress updates.
 * Replaces 3-second polling with server-pushed events.
 *
 * Usage: `new EventSource("/api/jobs/<id>/stream")`
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let lastProgress = -1;
      let lastStatus = "";

      const poll = async () => {
        try {
          const job = await queryOne<JobRow>(
            `SELECT id, status, progress, current_section, total_sections,
                    audio_storage_path, duration_seconds, error_message
             FROM jobs WHERE id = ?`,
            [id]
          );

          if (!job) {
            send({ error: "Job not found" });
            controller.close();
            return false;
          }

          const progress = job.progress ?? 0;
          const status = job.status;

          // Only send when something changed
          if (progress !== lastProgress || status !== lastStatus) {
            lastProgress = progress;
            lastStatus = status;
            send({
              status,
              progress,
              current_section: job.current_section,
              total_sections: job.total_sections,
              audio_storage_path: job.audio_storage_path,
              duration_seconds: job.duration_seconds,
              error_message: job.error_message,
            });
          }

          // Close stream when job reaches terminal state
          if (status === "ready" || status === "failed") {
            controller.close();
            return false;
          }

          return true;
        } catch {
          return true; // keep trying on transient errors
        }
      };

      // Poll DB every 1.5 seconds (faster than client-side 3s polling)
      const shouldContinue = await poll();
      if (!shouldContinue) return;

      const interval = setInterval(async () => {
        const shouldContinue = await poll();
        if (!shouldContinue) clearInterval(interval);
      }, 1500);

      // Clean up on client disconnect
      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
