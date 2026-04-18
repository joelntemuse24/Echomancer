import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = createServerClient();

    // Fetch job to get storage paths before deleting the row
    const { data: job } = await supabase
      .from("jobs")
      .select("pdf_storage_path, voice_storage_path, audio_storage_path")
      .eq("id", id)
      .single();

    // Delete associated storage files (ignore errors — files may not exist)
    if (job) {
      const pathsToDelete = [
        job.pdf_storage_path,
        job.voice_storage_path,
        job.audio_storage_path,
      ].filter(Boolean);

      // Also delete the chunks folder for this job
      const { data: chunkFiles } = await supabase.storage
        .from("audiobooks")
        .list(`chunks/${id}`);

      if (chunkFiles && chunkFiles.length > 0) {
        const chunkPaths = chunkFiles.map(f => `chunks/${id}/${f.name}`);
        pathsToDelete.push(...chunkPaths);
      }

      if (pathsToDelete.length > 0) {
        const { error: storageError } = await supabase.storage
          .from("audiobooks")
          .remove(pathsToDelete);

        if (storageError) {
          console.warn(`[Job ${id}] Failed to delete some storage files: ${storageError.message}`);
        }
      }
    }

    const { error: deleteError } = await supabase
      .from("jobs")
      .delete()
      .eq("id", id);

    if (deleteError) {
      return NextResponse.json(
        { error: "Failed to delete job" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, message: "Job deleted" });
  } catch (error) {
    console.error("Delete job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
