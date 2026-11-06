/**
 * Fish Audio live HTTP stream proxy.
 *
 * Pipes chunked MP3 from Fish `POST /v1/tts` so the browser can progressive-play
 * a preview (or short sample) without waiting for the full clip. Prefer this
 * over `/api/tts/preview` for Fish / clone voices.
 *
 * WebSocket `/api/tts/live` is not used here — that protocol is for token-by-token
 * LLM text. Preview and listen already have the full string.
 *
 * A saved clone's one-line preview is only synthesized when nothing is stored
 * yet; `GET /api/tts/clones/[id]/preview` serves the stored take and is what the
 * picker asks for first. Both routes derive the text and speed through
 * `clone-preview.ts`, so the storage key always matches.
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
import {
  deliveryUserInputFromUnknown,
  type DeliveryUserInput,
} from "@/lib/tts/delivery-settings";
import { resolveSessionUserId } from "@/lib/auth/session";
import {
  storeClonePreview,
} from "@/lib/tts/clone-preview-store";
import {
  clonePreviewPathForCatalog,
  MAX_PREVIEW_CHARS,
  planClonePreview,
  previewAudioResponse,
  storedClonePreviewAudio,
} from "@/lib/tts/clone-preview";
import { z } from "zod";

export const runtime = "nodejs";
/** Streaming preview — stay under Hobby limits; Fish emits early chunks. */
export const maxDuration = 60;

const liveRateLimit = createRateLimiter("tts-live", 20, 60_000, { onError: "closed" });

const liveTtsOptionsSchema = z
  .object({
    pauseStyle: z.enum(["auto", "sparse", "normal"]).optional(),
    normalizeTitles: z.union([z.literal("auto"), z.boolean()]).optional(),
    deliveryPrefix: z.union([z.literal("auto"), z.boolean()]).optional(),
  })
  .optional();

const bodySchema = z.object({
  catalogVoiceId: z.string().min(1).max(200),
  /** Optional sample text; defaults to the shared preview line. */
  text: z.string().min(1).max(MAX_PREVIEW_CHARS).optional(),
  ttsOptions: liveTtsOptionsSchema,
});

type LiveInput = {
  catalogVoiceId: string;
  text: string;
  ttsOptions: DeliveryUserInput;
};

function parseAutoBool(raw: string | null): boolean | "auto" | undefined {
  if (raw == null || raw === "") return undefined;
  if (raw === "auto") return "auto";
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  return undefined;
}

function ttsOptionsFromSearchParams(
  searchParams: URLSearchParams
): DeliveryUserInput {
  return deliveryUserInputFromUnknown({
    pauseStyle: searchParams.get("pauseStyle") || undefined,
    normalizeTitles: parseAutoBool(searchParams.get("normalizeTitles")),
    deliveryPrefix: parseAutoBool(searchParams.get("deliveryPrefix")),
  });
}

async function parseLiveInput(
  request: NextRequest
): Promise<LiveInput | NextResponse> {
  if (request.method === "GET") {
    const { searchParams } = new URL(request.url);
    const catalogVoiceId = searchParams.get("catalogVoiceId");
    if (!catalogVoiceId) {
      return NextResponse.json(
        { error: "Choose a voice." },
        { status: 400 }
      );
    }
    const textParam = searchParams.get("text") || undefined;
    if (textParam && textParam.length > MAX_PREVIEW_CHARS) {
      return NextResponse.json(
        { error: `Live samples are limited to ${MAX_PREVIEW_CHARS} characters.` },
        { status: 400 }
      );
    }
    return {
      catalogVoiceId,
      text: (textParam?.trim() || PREVIEW_TEXT).slice(0, MAX_PREVIEW_CHARS),
      ttsOptions: ttsOptionsFromSearchParams(searchParams),
    };
  }

  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose a voice." },
      { status: 400 }
    );
  }
  return {
    catalogVoiceId: parsed.data.catalogVoiceId,
    text: (parsed.data.text?.trim() || PREVIEW_TEXT).slice(0, MAX_PREVIEW_CHARS),
    ttsOptions: deliveryUserInputFromUnknown(parsed.data.ttsOptions),
  };
}

async function handleLive(request: NextRequest): Promise<NextResponse | Response> {
  try {
    if (!isFishConfigured()) {
      return NextResponse.json(
        {
          error:
            "This sample isn't available. Try again.",
        },
        { status: 503 }
      );
    }

    const userId = await resolveSessionUserId(request);
    const ip = clientIp(request);
    if (
      !(await liveRateLimit(
        await rateLimitIdentity({ userId, ip })
      ))
    ) {
      return NextResponse.json(
        { error: "Wait a minute." },
        { status: 429 }
      );
    }

    const input = await parseLiveInput(request);
    if (input instanceof NextResponse) return input;

    const catalog = await getCatalogVoice(input.catalogVoiceId, {
      hdEnabled: true,
      userId,
    });
    if (!catalog) {
      return NextResponse.json(
        { error: "That voice isn't available." },
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
            "This sample isn't available for this narrator.",
        },
        { status: 400 }
      );
    }

    if (
      !isResearchVoice(catalog) &&
      catalog.provider !== "fish" &&
      isHdVoice(catalog) &&
      !isPremiumHdEnabled({ ip, userId })
    ) {
      return NextResponse.json(
        { error: "HD voices are a premium feature. Use a standard narrator." },
        { status: 403 }
      );
    }

    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort());

    const plan = planClonePreview({
      catalogVoiceId: catalog.id,
      text: input.text,
      ttsOptions: input.ttsOptions,
    });

    // A saved clone's preview line is synthesized once, then served from
    // storage. `catalog` came from the user-scoped lookup above, so this only
    // ever reaches the caller's own clone. Custom sample text stays live.
    const storedPreviewPath = clonePreviewPathForCatalog(
      catalog,
      plan,
      input.text
    );
    if (storedPreviewPath) {
      // A stored preview is complete by construction — `storeClonePreview`
      // never writes a silent take — so it can be answered without asking
      // Fish anything.
      const stored = await storedClonePreviewAudio(storedPreviewPath);
      if (stored) return previewAudioResponse(stored, "stored");
    }

    const { response: fishRes, endLive } = await startFishHttpStream(
      {
        text: plan.script,
        voiceId: catalog.providerVoiceId,
        catalogVoiceId: catalog.id,
        language: catalog.locale,
        model: catalog.model,
        speed: plan.speed,
        signal: abort.signal,
      },
      { latency: "balanced" }
    );

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Full copy of the take, kept only when this is a clone preview to store.
        const kept: Uint8Array[] | null = storedPreviewPath ? [] : null;
        const keepIfComplete = async () => {
          if (!storedPreviewPath || !kept || abort.signal.aborted) return;
          await storeClonePreview(storedPreviewPath, Buffer.concat(kept));
        };
        try {
          if (!fishRes.body) {
            const buf = Buffer.from(await fishRes.arrayBuffer());
            if (buf.length) {
              controller.enqueue(new Uint8Array(buf));
              kept?.push(buf);
            }
            await keepIfComplete();
            controller.close();
            return;
          }
          const reader = fishRes.body.getReader();
          try {
            let complete = false;
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                complete = true;
                break;
              }
              if (abort.signal.aborted) break;
              if (value?.length) {
                controller.enqueue(value);
                kept?.push(value);
              }
            }
            if (complete) await keepIfComplete();
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
        ...(storedPreviewPath ? { "X-Echomancer-Preview": "generated" } : {}),
      },
    });
  } catch (error) {
    console.error("[tts/live] error:", error);
    const raw = error instanceof Error ? error.message : "Preview failed";
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
