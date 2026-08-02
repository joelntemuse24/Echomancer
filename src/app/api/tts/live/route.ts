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
  isFishConfigured,
  isFishLiveVoice,
  streamFishHttp,
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
      text: (textParam?.trim() || PREVIEW_TEXT).slice(0, MAX_LIVE_CHARS),
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
    text: (parsed.data.text?.trim() || PREVIEW_TEXT).slice(0, MAX_LIVE_CHARS),
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

    const iterator = streamFishHttp(
      {
        text: input.text,
        voiceId: catalog.providerVoiceId,
        language: catalog.locale,
        model: catalog.model,
        signal: abort.signal,
      },
      { latency: "balanced" }
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
          console.error("[tts/live] stream error:", err);
          try {
            controller.error(err);
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        abort.abort();
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
    return NextResponse.json(
      { error: userFriendlyError(raw) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleLive(request);
}

export async function POST(request: NextRequest) {
  return handleLive(request);
}
