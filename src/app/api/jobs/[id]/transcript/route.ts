import { NextRequest, NextResponse } from "next/server";
import { requireOwnedJob } from "@/lib/auth/guard";
import { handleApiError } from "@/lib/errors";
import { downloadFile } from "@/lib/storage";
import { loadFrozenScript, sectionStartsPath } from "@/lib/tts/frozen-script";
import {
  buildReadAlongDocument,
  type MeasuredSectionStarts,
} from "@/lib/player/read-along";
import type { JobSegment } from "@/lib/tts/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readable transcript for the player. Reads text already stored for the job.
 * Does not freeze, tag, or synthesize.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { job } = await requireOwnedJob(request, id);
    const frozen = await loadFrozenScript(id);
    const durations = durationsByIndex(
      typeof job.segments_json === "string" ? job.segments_json : null
    );

    if (frozen?.sections.length) {
      const doc = buildReadAlongDocument({
        frozenSections: frozen.sections.map((section) => ({
          index: section.index,
          text: section.text,
          durationSeconds: durations.get(section.index) ?? null,
        })),
        // Measured MP3-frame clock from finalize (the same clock chapters
        // use). Without it the transcript falls back to provider estimates.
        measuredStarts: await readMeasuredStarts(id),
        totalSeconds:
          typeof job.duration_seconds === "number" && job.duration_seconds > 0
            ? job.duration_seconds
            : null,
      });
      return NextResponse.json(doc);
    }

    const path =
      typeof job.pdf_storage_path === "string" ? job.pdf_storage_path : "";
    let contentText = "";
    if (path) {
      try {
        contentText = (await downloadFile(path)).toString("utf-8");
      } catch {
        contentText = "";
      }
    }
    return NextResponse.json(buildReadAlongDocument({ contentText }));
  } catch (error) {
    return handleApiError(error);
  }
}

function durationsByIndex(raw: string | null): Map<number, number> {
  const map = new Map<number, number>();
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as JobSegment[];
    if (!Array.isArray(parsed)) return map;
    for (const segment of parsed) {
      if (
        typeof segment.index === "number" &&
        typeof segment.durationSeconds === "number" &&
        segment.durationSeconds > 0
      ) {
        map.set(segment.index, segment.durationSeconds);
      }
    }
  } catch {
    /* ignore malformed segment list */
  }
  return map;
}

/** Measured section starts from finalize, when the book has them. */
async function readMeasuredStarts(jobId: string): Promise<MeasuredSectionStarts | null> {
  try {
    const parsed = JSON.parse(
      (await downloadFile(sectionStartsPath(jobId))).toString("utf8")
    ) as { sectionStarts?: unknown; totalSeconds?: unknown };
    if (!Array.isArray(parsed.sectionStarts) || typeof parsed.totalSeconds !== "number") {
      return null;
    }
    if (!(parsed.totalSeconds > 0)) return null;
    return { sectionStarts: parsed.sectionStarts as number[], totalSeconds: parsed.totalSeconds };
  } catch {
    return null;
  }
}
