import { NextRequest } from "next/server";
import { createStreamAudioIterator } from "@/lib/tts/stream-session";
import { userFriendlyError } from "@/lib/errors-ui";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const abort = new AbortController();

  request.signal.addEventListener("abort", () => abort.abort());

  try {
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
    const message = error instanceof Error ? error.message : "Stream failed";
    console.error(`[stream ${id}] error:`, message, error instanceof Error ? error.stack : error);
    const status = message.includes("not found")
      ? 404
      : message.includes("budget") || message.includes("finished")
        ? 402
        : message.includes("streamable") || message.includes("Not a stream")
          ? 409
          : 500;
    return new Response(
      JSON.stringify({ error: userFriendlyError(message), code: status === 402 ? "STREAM_BUDGET" : undefined }),
      {
        status,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
