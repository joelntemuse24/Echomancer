import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { resolveSessionUserId } from "@/lib/auth/session";
import { queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { isMarkupOperator } from "@/lib/operator/tools";
import {
  loadStoredFishMarkup,
  toPublicFishMarkup,
  type OwnedMarkupJob,
  type PublicFishMarkup,
} from "@/lib/tts/fish-markup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Allowlisted-operator view of the frozen cue-tagged speakable and, for
 * Fish jobs, the exact `text` string each section sends to Fish.
 *
 * Hidden unless the master switch is on and the session is on
 * `ECHO_OPERATOR_USER_IDS`, or `ECHO_OPERATOR_EMAILS` with a verified
 * Google email. Job ownership does not qualify. An allowlisted operator
 * can read any non-deleted job. The JSON has no owner email, name, or
 * user id. Everyone else gets the same 404 as a missing job. Does not re-tag.
 */

function notFound(): NextResponse {
  return NextResponse.json({ error: "Job not found" }, { status: 404 });
}

function parseSectionIndex(raw: string | null): number | "absent" | "invalid" {
  if (raw == null || raw === "") return "absent";
  if (!/^\d+$/.test(raw)) return "invalid";
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) return "invalid";
  return index;
}

function selectSection(
  markup: PublicFishMarkup,
  section: number | "absent"
): PublicFishMarkup | "missing" {
  if (section === "absent") return markup;
  const one = markup.sections.find((s) => s.index === section);
  if (!one) return "missing";
  return { ...markup, sections: [one] };
}

function plainBody(markup: PublicFishMarkup, singleSection: boolean): string {
  const sections = markup.sections;
  if (singleSection && sections.length === 1) {
    const section = sections[0]!;
    return markup.fishBound ? (section.fishText ?? section.storedText) : section.storedText;
  }
  return sections
    .map((section) => {
      const body = markup.fishBound
        ? (section.fishText ?? section.storedText)
        : section.storedText;
      return `----- section ${section.index} -----\n${body}`;
    })
    .join("\n\n");
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await resolveSessionUserId(request);
    if (!(await isMarkupOperator(userId))) return notFound();

    await ensureTtsJobColumns();
    const { id } = await params;
    const job = await queryOne<
      OwnedMarkupJob & {
        book_title: string | null;
        voice_name: string | null;
        created_at: number | null;
        updated_at: number | null;
      }
    >(
      `SELECT id, tts_provider, tts_options, book_title, voice_name, created_at, updated_at
       FROM jobs WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (!job) return notFound();

    const section = parseSectionIndex(request.nextUrl.searchParams.get("section"));
    if (section === "invalid") {
      return NextResponse.json(
        { error: "section must be a non-negative integer" },
        { status: 400 }
      );
    }

    const markup = await loadStoredFishMarkup(job);
    if (!markup) {
      return NextResponse.json(
        {
          error: "Markup is not frozen yet",
          code: "MARKUP_NOT_FROZEN",
        },
        { status: 404 }
      );
    }

    const selected = selectSection(toPublicFishMarkup(markup, job), section);
    if (selected === "missing") {
      return NextResponse.json(
        { error: "Section not found", code: "SECTION_NOT_FOUND" },
        { status: 404 }
      );
    }

    const headers = {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    };

    if (request.nextUrl.searchParams.get("format") === "text") {
      return new NextResponse(plainBody(selected, section !== "absent"), {
        headers: {
          ...headers,
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    return NextResponse.json(selected, { headers });
  } catch (error) {
    return handleApiError(error);
  }
}
