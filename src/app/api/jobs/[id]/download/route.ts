import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/turso/jobs";
import { downloadFile } from "@/lib/storage";
import type { JobSegment } from "@/lib/tts/types";

export const runtime = "nodejs";

type AudioFormat = {
  extension: "mp3" | "wav" | "ogg" | "pcm";
  contentType: string;
};

function getSegmentFormat(segment: JobSegment): AudioFormat | null {
  const contentType = segment.contentType?.split(";", 1)[0]?.toLowerCase();
  if (contentType === "audio/mpeg" || contentType === "audio/mp3") {
    return { extension: "mp3", contentType: "audio/mpeg" };
  }
  if (contentType === "audio/wav" || contentType === "audio/x-wav") {
    return { extension: "wav", contentType: "audio/wav" };
  }
  if (contentType === "audio/ogg" || contentType === "application/ogg") {
    return { extension: "ogg", contentType: "audio/ogg" };
  }
  if (contentType === "audio/pcm" || contentType === "audio/l16") {
    return { extension: "pcm", contentType: "audio/pcm" };
  }

  const extension = segment.path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension === "mp3") return { extension, contentType: "audio/mpeg" };
  if (extension === "wav") return { extension, contentType: "audio/wav" };
  if (extension === "ogg") return { extension, contentType: "audio/ogg" };
  if (extension === "pcm") return { extension, contentType: "audio/pcm" };
  return null;
}

/**
 * H10: Download full audiobook — concatenates all ready segments into a single MP3 stream.
 */
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

    const row = job as typeof job & Record<string, unknown>;
    let segments: JobSegment[] = [];
    if (typeof row.segments_json === "string" && row.segments_json) {
      try {
        segments = (JSON.parse(row.segments_json as string) as JobSegment[])
          .filter((s) => s.status === "ready")
          .sort((a, b) => a.index - b.index);
      } catch {
        segments = [];
      }
    }

    if (segments.length === 0) {
      return NextResponse.json({ error: "No audio segments available" }, { status: 404 });
    }

    const format = getSegmentFormat(segments[0]!);
    if (
      !format ||
      segments.some(
        (segment) => getSegmentFormat(segment)?.extension !== format.extension
      )
    ) {
      return NextResponse.json(
        { error: "Audio segments do not share a supported format" },
        { status: 409 }
      );
    }

    const safeTitle = (job.book_title || "audiobook").replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const filename = `${safeTitle}.${format.extension}`;

    // Stream all segments concatenated
    const stream = new ReadableStream({
      async start(controller) {
        for (const seg of segments) {
          try {
            const buf = await downloadFile(seg.path);
            controller.enqueue(new Uint8Array(buf));
          } catch (err) {
            console.error(`[Download ${id}] Failed to read segment ${seg.index}:`, err);
          }
        }
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": format.contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private",
      },
    });
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
