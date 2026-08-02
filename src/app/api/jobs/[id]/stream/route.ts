import { NextRequest, NextResponse } from "next/server";
import { createStreamAudioIterator } from "@/lib/tts/stream-session";
import { userFriendlyError } from "@/lib/errors-ui";
import { requireOwnedJob } from "@/lib/auth/guard";
import { handleApiError } from "@/lib/errors";
import { AppError } from "@/lib/errors";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

// Each open stream is billable synthesis, so this fails closed: an unavailable
// counter must not turn into unmetered narration.
const streamRateLimit = createRateLimiter(20, 60_000, { onError: "closed" });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  try {
    const { session } = await requireOwnedJob(
      request,
      id,
      "id, user_id, status, job_kind, pdf_storage_path"
    );

    const identity = await rateLimitIdentity({
      userId: session.userId,
      ip: clientIp(request),
    });
    if (!(await streamRateLimit(identity))) {
      return NextResponse.json(
        { error: "Too many listening sessions. Please wait a minute." },
        { status: 429 }
      );
    }

    const { contentType, iterator } = await createStreamAudioIterator(
      id,
      abort.signal
    );

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of iterator) {
            if (abort.signal.aborted) break;
            controller.enqueue(chunk);
          }
          controller.close();
        } catch (err) {
          console.error(`[stream ${id}] iterator error:`, err);
          controller.error(err);
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof AppError) return handleApiError(error);

    const message = error instanceof Error ? error.message : "Stream failed";
    console.error(`[stream ${id}] error:`, message);
    const finished = message.includes("end of book") || message.includes("Stream finished");
    const budget = message.includes("budget");
    const status = message.includes("not found")
      ? 404
      : finished || budget
        ? 402
        : message.includes("streamable") || message.includes("Not a stream")
          ? 409
          : 500;
    return NextResponse.json(
      {
        error: userFriendlyError(message),
        code:
          status === 402
            ? finished
              ? "STREAM_FINISHED"
              : "STREAM_BUDGET"
            : undefined,
      },
      { status }
    );
  }
}
