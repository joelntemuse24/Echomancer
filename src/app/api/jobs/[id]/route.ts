import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deleteJob, getJob, resetJob } from "@/lib/db/jobs";
import { deleteFile, fileExists, getFullPath } from "@/lib/storage";
import fs from "fs/promises";
import path from "path";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = getJob(id);

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Format job to match old Supabase format
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
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = getJob(id);

    if (job) {
      // Delete associated storage files
      const pathsToDelete = [
        job.pdf_storage_path,
        job.voice_storage_path,
        job.audio_storage_path,
      ].filter((p): p is string => Boolean(p));

      // Delete chunks folder
      const chunksDir = path.join(process.env.STORAGE_PATH || "./data/storage", "checkpoints", id);
      try {
        await fs.rm(chunksDir, { recursive: true, force: true });
      } catch {
        // Ignore errors - folder may not exist
      }

      // Delete individual files
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

    // Soft delete the job
    deleteJob(id);

    return NextResponse.json({ success: true, message: "Job deleted" });
  } catch (error) {
    console.error("Delete job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
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
      const job = getJob(id);
      if (!job) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      }

      if (job.status !== "failed") {
        return NextResponse.json(
          { error: "Can only retry failed jobs" },
          { status: 400 }
        );
      }

      resetJob(id);

      // Re-trigger generation
      const { generateAudiobookF5Modal } = await import("@/lib/generate-audiobook-f5-modal");
      const voicePaths = job.voice_storage_path
        ? job.voice_storage_path.split(",").filter((p) => p.trim())
        : [];

      generateAudiobookF5Modal({
        jobId: id,
        pdfStoragePath: job.pdf_storage_path,
        voiceStoragePath: voicePaths[0] || null,
        voiceStoragePaths: voicePaths.length > 1 ? voicePaths : undefined,
        videoId: job.video_id,
        startTime: job.start_time,
        endTime: job.end_time,
      }).catch((err) => {
        console.error(`[Job ${id}] Retry error:`, err);
      });

      return NextResponse.json({ success: true, message: "Job reset for retry" });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Patch job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
