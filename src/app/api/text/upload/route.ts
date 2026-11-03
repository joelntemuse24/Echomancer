/**
 * Paste-text intake — same ownership/storage shape as document upload, without
 * file extraction. Stores UTF-8 `content.txt` under `pdfs/<id>/` so jobs reuse
 * the existing pdfStoragePath pipeline.
 *
 * A `url` body reads a public http(s) page first, then stores that text the
 * same way. Private hosts, link-local addresses, and odd ports are refused.
 */

import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { MIN_EXTRACTED_CHARS } from "@/lib/document-formats";
import {
  CHAPTERS_JSON_NAME,
  safeResolveChapters,
  type ChapterHint,
} from "@/lib/book-chapters";
import { relocatePageStarts } from "@/lib/page-offsets";
import { scheduleListenPrep } from "@/lib/tts/listen-prep-cache";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import { normalizeSourceText } from "@/lib/source-text";
import { uploadFile } from "@/lib/storage";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  attachSessionCookie,
  readOrMintSession,
  SessionSecretMissingError,
} from "@/lib/auth/session";
import { recordUpload } from "@/lib/turso/uploads";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { readPublicUrl } from "@/lib/fetch-public-page";
import { PASTE_MAX_CHARS, URL_MAX_CHARS } from "@/lib/paste-limits";
import { PublicUrlError } from "@/lib/public-url";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

export { PASTE_MAX_CHARS };

const pasteRateLimit = createRateLimiter("text-upload", 15, 60_000, { onError: "closed" });

const RANGE_MESSAGE = `Paste ${MIN_EXTRACTED_CHARS} to ${PASTE_MAX_CHARS.toLocaleString()} characters.`;

const bodySchema = z
  .object({
    text: z.string().min(1).max(PASTE_MAX_CHARS).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
    title: z.string().trim().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const hasText = Boolean(value.text?.trim());
    const hasUrl = Boolean(value.url?.trim());
    if (hasText === hasUrl) {
      ctx.addIssue({
        code: "custom",
        message: hasText ? "both" : "neither",
        path: ["body"],
      });
    }
  });

/**
 * Every source — paste, fetched page, uploaded document — runs the same
 * `normalizeSourceText` paragraph pass before `toSpeakableText`. Nothing here
 * has a paste-only branch: a URL's HTML is reduced to text upstream, and from
 * that point the words take one path.
 */
function prepareSourceText(raw: string): string {
  return normalizeSourceText(raw);
}

function hostnameTitle(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

function pasteBodyError(error: z.ZodError): AppError {
  const messages = error.issues.map((issue) => issue.message);
  if (messages.includes("both")) {
    return new AppError("INVALID_BODY", "Send text or a link.", 400);
  }
  if (error.issues.some((issue) => issue.path[0] === "url") && !messages.includes("neither")) {
    return new AppError(
      "INVALID_URL",
      "Use a full http or https link.",
      400
    );
  }
  return new AppError("INVALID_BODY", RANGE_MESSAGE, 400);
}

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();

    const { session, minted } = await readOrMintSession(request);

    if (
      !(await pasteRateLimit(
        await rateLimitIdentity({
          userId: session.userId,
          ip: clientIp(request),
        })
      ))
    ) {
      return NextResponse.json(
        { error: "Too many pastes. Wait a minute." },
        { status: 429 }
      );
    }

    const raw = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw pasteBodyError(parsed.error);

    let sourceText = "";
    let pageTitle: string | null = null;
    let fromUrl = false;
    let chapterHint: ChapterHint | null = null;

    if (parsed.data.url) {
      fromUrl = true;
      try {
        const page = await readPublicUrl(parsed.data.url);
        sourceText = page.text;
        pageTitle = page.title;
        // A PDF or EPUB link carries the outline the upload extract found.
        // The hint only affects chapter detection; the text still runs the
        // same cleanup pass as every other source.
        chapterHint = page.chapterHint ?? null;
      } catch (error) {
        if (error instanceof PublicUrlError) {
          throw new AppError(
            error.code,
            error.message,
            error.code === "URL_TOO_LARGE" ? 413 : 400
          );
        }
        throw error;
      }
    } else {
      sourceText = parsed.data.text ?? "";
    }

    // One pass for paste, page, and document text: the shared paragraph pass,
    // then the shared speakable cleanup. Raw entities ("&amp;") that a copy
    // out of HTML leaves behind are decoded inside `toSpeakableText`.
    const text = toSpeakableText(prepareSourceText(sourceText), {
      normalizeTitles: false,
    });
    if (text.length < MIN_EXTRACTED_CHARS) {
      throw new AppError(
        "EMPTY_TEXT",
        fromUrl
          ? "Not enough text. Paste it instead."
          : `Paste at least ${MIN_EXTRACTED_CHARS} characters.`,
        400
      );
    }
    const ceiling = fromUrl ? URL_MAX_CHARS : PASTE_MAX_CHARS;
    if (text.length > ceiling) {
      throw new AppError(
        "TEXT_TOO_LONG",
        fromUrl
          ? "That page is too long. Paste the text."
          : `Too long. Maximum is ${PASTE_MAX_CHARS.toLocaleString()} characters.`,
        413
      );
    }

    const title =
      parsed.data.title?.trim() ||
      pageTitle?.trim() ||
      (fromUrl ? hostnameTitle(parsed.data.url ?? "") : null) ||
      text.split(/\n/).find((line) => line.trim())?.slice(0, 80) ||
      "Pasted text";

    const fileId = randomUUID();
    const basePath = `pdfs/${fileId}`;
    const bytes = Buffer.from(text, "utf-8");

    const textResult = await uploadFile(
      basePath,
      "content.txt",
      bytes,
      "text/plain; charset=utf-8"
    );

    // Same chapter outline a document gets from extraction: heading lines in
    // the stored speakable text, refined by an outline or page map when the
    // source was a document link. Detection failure stores an empty outline,
    // never a failed upload.
    if (chapterHint?.pageProbes?.length && chapterHint.pageStarts?.length) {
      chapterHint = {
        ...chapterHint,
        pageStarts: relocatePageStarts(
          text,
          chapterHint.pageProbes,
          chapterHint.pageStarts
        ),
      };
    }
    const chapters = safeResolveChapters(text, chapterHint ?? {
      source: "heading-lines",
      titles: [],
    });
    try {
      await uploadFile(
        basePath,
        CHAPTERS_JSON_NAME,
        Buffer.from(JSON.stringify(chapters), "utf-8"),
        "application/json"
      );
    } catch (err) {
      console.warn(
        `[text/upload] chapters.json failed for ${fileId}:`,
        err instanceof Error ? err.message : err
      );
    }

    await recordUpload({
      id: fileId,
      userId: session.userId,
      storagePath: textResult.path,
      sourcePath: null,
      fileName: title.slice(0, 200),
      format: "txt",
      byteSize: bytes.length,
      charCount: text.length,
    });

    scheduleListenPrep(fileId);

    const response = NextResponse.json({
      uploadId: fileId,
      storagePath: textResult.path,
      fileName: title.slice(0, 200),
      fileSize: bytes.length,
      format: "txt",
      source: fromUrl ? "url" : "paste",
      charCount: text.length,
      paragraphCount: text.split(/\n\s*\n/).filter(Boolean).length,
    });

    if (minted) attachSessionCookie(response, session);
    return response;
  } catch (error) {
    if (error instanceof SessionSecretMissingError) {
      console.error("[text/upload]", error.message);
      return NextResponse.json(
        {
          error:
            "Uploads are off right now.",
        },
        { status: 503 }
      );
    }
    return handleApiError(error);
  }
}
