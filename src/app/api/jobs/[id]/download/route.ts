import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/turso/jobs";
import { downloadFile } from "@/lib/storage";
import type { JobSegment } from "@/lib/tts/types";
import {
  createWavHeader,
  isRawPcmContentType,
  stripWavHeader,
} from "@/lib/tts/pcm-wav";

export const runtime = "nodejs";

type AudioFormat = {
  extension: "mp3" | "wav" | "ogg";
  contentType: string;
};

function getSegmentFormat(segment: JobSegment): AudioFormat | null {
  const contentType = segment.contentType?.split(";", 1)[0]?.toLowerCase();
  if (contentType === "audio/mpeg" || contentType === "audio/mp3") {
    return { extension: "mp3", contentType: "audio/mpeg" };
  }
  if (
    contentType === "audio/wav" ||
    contentType === "audio/x-wav" ||
    contentType === "audio/pcm" ||
    contentType === "audio/l16"
  ) {
    // PCM and WAV both download as a single playable WAV
    return { extension: "wav", contentType: "audio/wav" };
  }
  if (contentType === "audio/ogg" || contentType === "application/ogg") {
    return { extension: "ogg", contentType: "audio/ogg" };
  }

  const extension = segment.path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension === "mp3") return { extension, contentType: "audio/mpeg" };
  if (extension === "wav" || extension === "pcm") {
    return { extension: "wav", contentType: "audio/wav" };
  }
  if (extension === "ogg") return { extension, contentType: "audio/ogg" };
  return null;
}

/**
 * Download full audiobook — concatenates all ready segments into one file.
 * WAV/PCM segments are merged under a single RIFF header.
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
      console.error(`[Download ${id}] Mixed or unsupported segment formats`);
      return NextResponse.json(
        { error: "This audiobook could not be downloaded because sections use different audio formats. Try regenerating." },
        { status: 409 }
      );
    }

    const safeTitle = (job.book_title || "audiobook").replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const filename = `${safeTitle}.${format.extension}`;

    if (format.extension === "wav") {
      // Concatenate PCM payloads under one WAV header
      const pcmParts: Buffer[] = [];
      for (const seg of segments) {
        try {
          const buf = await downloadFile(seg.path);
          if (isRawPcmContentType(seg.contentType) || seg.path.endsWith(".pcm")) {
            pcmParts.push(buf);
          } else {
            pcmParts.push(Buffer.from(stripWavHeader(buf)));
          }
        } catch (err) {
          console.error(`[Download ${id}] Failed to read segment ${seg.index}:`, err);
        }
      }
      const pcm = Buffer.concat(pcmParts);
      const wav = Buffer.concat([createWavHeader(pcm.length), pcm]);
      return new NextResponse(new Uint8Array(wav), {
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(wav.length),
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "private",
        },
      });
    }

    // MP3 / OGG — byte-concat is valid for these container-less / frame-based formats
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
