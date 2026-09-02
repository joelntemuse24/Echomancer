/**
 * Paste-text intake — same ownership/storage shape as document upload, without
 * file extraction. Stores UTF-8 `content.txt` under `pdfs/<id>/` so jobs reuse
 * the existing pdfStoragePath pipeline.
 */

import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { MIN_EXTRACTED_CHARS } from "@/lib/text-extraction";
import { toSpeakableText } from "@/lib/tts/speakable-text";
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
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Keep JSON bodies well under typical gateway limits. */
export const PASTE_MAX_CHARS = 500_000;

const pasteRateLimit = createRateLimiter(15, 60_000, { onError: "closed" });

const bodySchema = z.object({
  text: z.string().min(1).max(PASTE_MAX_CHARS),
  title: z.string().trim().max(200).optional(),
});

function normalizePastedText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
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
        { error: "Too many pastes. Please wait a minute and try again." },
        { status: 429 }
      );
    }

    const raw = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        "INVALID_BODY",
        `Paste text between ${MIN_EXTRACTED_CHARS} and ${PASTE_MAX_CHARS.toLocaleString()} characters.`,
        400
      );
    }

    const text = toSpeakableText(normalizePastedText(parsed.data.text));
    if (text.length < MIN_EXTRACTED_CHARS) {
      throw new AppError(
        "EMPTY_TEXT",
        `Please paste at least ${MIN_EXTRACTED_CHARS} characters of text.`,
        400
      );
    }
    if (text.length > PASTE_MAX_CHARS) {
      throw new AppError(
        "TEXT_TOO_LONG",
        `Pasted text is too long. Maximum is ${PASTE_MAX_CHARS.toLocaleString()} characters.`,
        413
      );
    }

    const title =
      parsed.data.title?.trim() ||
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

    await recordUpload({
      id: fileId,
      userId: session.userId,
      storagePath: textResult.path,
      sourcePath: null,
      fileName: title,
      format: "txt",
      byteSize: bytes.length,
      charCount: text.length,
    });

    const response = NextResponse.json({
      storagePath: textResult.path,
      fileName: title,
      fileSize: bytes.length,
      format: "txt",
      source: "paste",
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
            "This deployment is missing its session secret, so uploads are disabled.",
        },
        { status: 503 }
      );
    }
    return handleApiError(error);
  }
}
