import { NextRequest, NextResponse } from "next/server";
import { getJob, deleteJob, resetJob } from "@/lib/turso/jobs";
import { triggerAudiobookGeneration } from "@/lib/trigger-generation";
import { deleteFile, fileExists } from "@/lib/storage";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await getJob(id);

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const formattedJob = {
      id: job.id,
      user_id: job.user_id,
      book_title: job.book_title,
      pdf_storage_path: job.pdf_storage_path,
      voice_storage_path: job.voice_storage_path,
      voice_name: job.voice_name,
      video_id: job.video_id,
      start_time: job.start_time,
      end_time: job.end_time,
      status: job.status,
      progress: job.progress,
      current_section: job.current_section,
      total_sections: job.total_sections,
      audio_storage_path: job.audio_storage_path,
      duration_seconds: job.duration_seconds,
      error_message: job.error_message,
      created_at: new Date(job.created_at * 1000).toISOString(),
      updated_at: new Date(job.updated_at * 1000).toISOString(),
    };

    return NextResponse.json({ job: formattedJob });
  } catch (error) {
    console.error("Get job error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await getJob(id);

    if (job) {
      const pathsToDelete = [
        job.pdf_storage_path,
        // job.voice_storage_path, // REMOVED — don't delete shared voice files
        job.audio_storage_path,
      ].filter((p): p is string => Boolean(p));

      // Validate id is UUID-like before using in path
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidPattern.test(id)) {
        const chunksDir = path.join(process.env.STORAGE_PATH || "./data/storage", "checkpoints", id);
        const storageRoot = path.resolve(process.env.STORAGE_PATH || "./data/storage") + path.sep;
        const resolvedChunks = path.resolve(chunksDir) + path.sep;
        if (resolvedChunks.startsWith(storageRoot)) {
          try {
            await fs.rm(chunksDir, { recursive: true, force: true });
          } catch {
            // Ignore
          }
        }
      }

      for (const filePath of pathsToDelete) {
        try {
          if (await fileExists(filePath)) {
            await deleteFile(filePath);
          }
        } catch (err) {
          console.warn(`[Job ${id}] Failed to delete file ${filePath}:`, err);
        }
      }
    }

    await deleteJob(id);
    return NextResponse.json({ success: true, message: "Job deleted" });
  } catch (error) {
    console.error("Delete job error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.action === "retry") {
      const job = await getJob(id);
      if (!job) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      }

      if (job.status !== "failed") {
        return NextResponse.json(
          { error: "Can only retry failed jobs" },
          { status: 400 }
        );
      }

      await resetJob(id);

      // Actually restart generation — resetting alone leaves the job stuck
      // at "queued" forever since nothing else consumes queued jobs.
      await triggerAudiobookGeneration({
        jobId: id,
        pdfStoragePath: job.pdf_storage_path,
        voiceStoragePath: job.voice_storage_path,
        startTime: job.start_time,
        endTime: job.end_time,
        bookTitle: job.book_title,
        voiceName: job.voice_name ?? "Custom Voice",
      });

      return NextResponse.json({
        success: true,
        message: "Job reset and generation restarted",
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Patch job error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
