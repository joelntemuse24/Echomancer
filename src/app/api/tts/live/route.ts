/**
 * Fish Audio live HTTP stream proxy.
 *
 * Pipes chunked MP3 from Fish `POST /v1/tts` so the browser can progressive-play
 * a preview (or short sample) without waiting for the full clip. Prefer this
 * over `/api/tts/preview` for Fish / clone voices.
 *
 * WebSocket `/v1/tts/live` is not used here — that protocol is for token-by-token
 * LLM text. Preview and listen already have the full string.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCatalogVoice } from "@/lib/tts/catalog";
import {
  FishRateLimitError,
  isFishConfigured,
  isFishLiveVoice,
  startFishHttpStream,
} from "@/lib/tts/providers/fish";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";
import { isResearchVoice } from "@/lib/tts/research-preview";
import { userFriendlyError } from "@/lib/errors-ui";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import { toFishNarrationScript } from "@/lib/tts/narration-script";
import { readSession } from "@/lib/auth/session";
import { z } from "zod";

export const runtime = "nodejs";
/** Streaming preview — stay under Hobby limits; Fish emits early chunks. */
export const maxDuration = 60;

const liveRateLimit = createRateLimiter(20, 60_000, { onError: "closed" });

const MAX_LIVE_CHARS = 2_000;

const bodySchema = z.object({
  catalogVoiceId: z.string().min(1).max(200),
  /** Optional sample text; defaults to the shared preview line. */
  text: z.string().min(1).max(MAX_LIVE_CHARS).optional(),
});

type LiveInput = { catalogVoiceId: string; text: string };

async function parseLiveInput(
  request: NextRequest
): Promise<LiveInput | NextResponse> {
  if (request.method === "GET") {
    const { searchParams } = new URL(request.url);
    const catalogVoiceId = searchParams.get("catalogVoiceId");
    if (!catalogVoiceId) {
      return NextResponse.json(
        { error: "Please select a narrator to preview." },
        { status: 400 }
      );
    }
    const textParam = searchParams.get("text") || undefined;
    if (textParam && textParam.length > MAX_LIVE_CHARS) {
      return NextResponse.json(
        { error: `Live samples are limited to ${MAX_LIVE_CHARS} characters.` },
        { status: 400 }
      );
    }
    return {
      catalogVoiceId,
      text: toSpeakableText(textParam?.trim() || PREVIEW_TEXT).slice(
        0,
        MAX_LIVE_CHARS
      ),
    };
  }

  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please select a narrator to preview." },
      { status: 400 }
    );
  }
    return {
      catalogVoiceId: parsed.data.catalogVoiceId,
      text: toSpeakableText(parsed.data.text?.trim() || PREVIEW_TEXT).slice(
        0,
        MAX_LIVE_CHARS
      ),
    };
}

async function handleLive(request: NextRequest): Promise<NextResponse | Response> {
  try {
    if (!isFishConfigured()) {
      return NextResponse.json(
        {
          error:
            "Fish live streaming needs FISH_API_KEY. Use the standard preview for other narrators.",
        },
        { status: 503 }
      );
    }

    const session = await readSession(request);
    const ip = clientIp(request);
    if (
      !(await liveRateLimit(
        await rateLimitIdentity({ userId: session?.userId, ip })
      ))
    ) {
      return NextResponse.json(
        { error: "You're previewing too quickly. Please wait a minute." },
        { status: 429 }
      );
    }

    const input = await parseLiveInput(request);
    if (input instanceof NextResponse) return input;

    const catalog = await getCatalogVoice(input.catalogVoiceId, {
      hdEnabled: true,
      userId: session?.userId,
    });
    if (!catalog) {
      return NextResponse.json(
        { error: "That narrator isn't available right now." },
        { status: 404 }
      );
    }

    if (
      !isFishLiveVoice({
        provider: catalog.provider,
        model: catalog.model,
        catalogVoiceId: catalog.id,
        tags: catalog.tags,
      })
    ) {
      return NextResponse.json(
        {
          error:
            "Live Fish streaming is only available for Fish Audio narrators. Use Preview for other voices.",
        },
        { status: 400 }
      );
    }

    if (
      !isResearchVoice(catalog) &&
      catalog.provider !== "fish" &&
      isHdVoice(catalog) &&
      !isPremiumHdEnabled({ ip, userId: session?.userId })
    ) {
      return NextResponse.json(
        { error: "HD voices are a premium feature. Use a standard narrator." },
        { status: 403 }
      );
    }

    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort());

    // Open Fish *before* returning 200 so a 400 (e.g. Reference not found)
    // becomes JSON instead of a stream that Next.js maps to HTML /500.
    const { response: fishRes, endLive } = await startFishHttpStream(
      {
        text: toFishNarrationScript(input.text),
        voiceId: catalog.providerVoiceId,
        catalogVoiceId: catalog.id,
        language: catalog.locale,
        model: catalog.model,
        signal: abort.signal,
      },
      { latency: "balanced" }
    );

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (!fishRes.body) {
            const buf = Buffer.from(await fishRes.arrayBuffer());
            if (buf.length) controller.enqueue(new Uint8Array(buf));
            controller.close();
            return;
          }
          const reader = fishRes.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || abort.signal.aborted) break;
              if (value?.length) controller.enqueue(value);
            }
            controller.close();
          } finally {
            reader.releaseLock();
          }
        } catch (err) {
          console.error("[tts/live] stream error:", err);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        } finally {
          await endLive();
        }
      },
      cancel() {
        abort.abort();
        void endLive();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Echomancer-Stream": "fish-http",
      },
    });
  } catch (error) {
    console.error("[tts/live] error:", error);
    const raw = error instanceof Error ? error.message : "Live stream failed";
    const status =
      error instanceof FishRateLimitError
        ? 429
        : error instanceof Error && /Fish TTS 4\d\d/.test(error.message)
          ? 502
          : 500;
    return NextResponse.json(
      { error: userFriendlyError(raw) },
      { status }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleLive(request);
}

export async function POST(request: NextRequest) {
  return handleLive(request);
}
