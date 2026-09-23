import { NextRequest, NextResponse } from "next/server";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";
import { isResearchVoice } from "@/lib/tts/research-preview";
import { userFriendlyError } from "@/lib/errors-ui";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { scriptDeliverySample } from "@/lib/tts/delivery-sample";
import {
  expressivePreviewCacheKey,
  readExpressivePreviewCache,
  writeExpressivePreviewCache,
} from "@/lib/tts/expressive-preview-cache";
import { resolveStockTwinLock } from "@/lib/tts/fish-stock-twins";
import { parseStockDeliveryMode } from "@/lib/tts/stock-delivery";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import { inferAccent } from "@/lib/tts/voice-persona";
import {
  geminiDirectedInput,
  modelSupportsAccentVariants,
  modelSupportsStyleInstructions,
} from "@/lib/tts/accent-prompt";
import { resolveSessionUserId } from "@/lib/auth/session";

export const runtime = "nodejs";
export const maxDuration = 30;

// Comparing narrators needs more than a handful per minute, but each preview is
// a paid synthesis call, so the limiter fails closed.
const previewRateLimit = createRateLimiter(15, 60_000, { onError: "closed" });

function previewAudioResponse(
  audio: Buffer | Uint8Array,
  contentType: string,
  cache?: "hit" | "miss"
): NextResponse {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    // The saved clip is keyed by script + twin ref. Do not let a CDN pin
    // this POST URL to an older take.
    "Cache-Control": "private, no-store",
  };
  if (cache) headers["X-Preview-Cache"] = cache;
  return new NextResponse(new Uint8Array(audio), { headers });
}

export async function POST(request: NextRequest) {
  try {
    const userId = await resolveSessionUserId(request);
    const ip = clientIp(request);
    if (
      !(await previewRateLimit(
        await rateLimitIdentity({ userId, ip })
      ))
    ) {
      return NextResponse.json(
        { error: "You're previewing too quickly. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      catalogVoiceId?: string;
      delivery?: unknown;
      sample?: unknown;
    };
    const { catalogVoiceId } = body;
    const delivery = parseStockDeliveryMode(body.delivery);
    const sample = body.sample === "compare" ? "compare" : "preview";

    if (!catalogVoiceId || typeof catalogVoiceId !== "string") {
      return NextResponse.json(
        { error: "Please select a narrator to preview." },
        { status: 400 }
      );
    }

    const catalog = await getCatalogVoice(catalogVoiceId, {
      hdEnabled: true,
      userId,
    });
    if (!catalog) {
      return NextResponse.json(
        { error: "That narrator isn't available right now." },
        { status: 404 }
      );
    }

    const twinLock = resolveStockTwinLock(catalog, delivery);
    if (twinLock.status === "rejected") {
      return NextResponse.json(
        {
          error:
            twinLock.code === "EXPRESSIVE_UNAVAILABLE"
              ? "Expressive isn't available for this narrator yet."
              : "Expressive isn't offered for this narrator.",
          code: twinLock.code,
        },
        { status: 400 }
      );
    }
    const providerId =
      twinLock.status === "locked" ? twinLock.provider : catalog.provider;
    const providerVoiceId =
      twinLock.status === "locked"
        ? twinLock.providerVoiceId
        : catalog.providerVoiceId;
    const model =
      twinLock.status === "locked" ? twinLock.model : catalog.model;

    // Research Free API voices skip the paid HD gate; OpenRouter HD still uses it.
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

    if (!isStockProvider(providerId)) {
      return NextResponse.json(
        { error: "That narrator isn't supported." },
        { status: 400 }
      );
    }

    const provider = resolveStockAdapter({
      provider: providerId,
      model,
      catalogVoiceId: catalog.id,
    });

    const { resolveStylePrompt } = await import("@/lib/tts/resolve-style-prompt");
    const accent =
      catalog.accentHint ||
      (catalog as { accent?: string }).accent ||
      inferAccent(catalog);

    const isGemini = modelSupportsAccentVariants(model);
    // Gemini: put accent in the input (Google's documented pattern).
    // Avoid a separate aggressive `prompt` — it was returning empty PCM.
    // Other vendors only get a style prompt when they actually honour it.
    // Play-both uses the compare line (narration script). Row preview stays
    // the short one-liner. Neither path reads the uploaded book.
    const sampleText = scriptDeliverySample(sample, providerId);
    const text = isGemini
      ? geminiDirectedInput(sampleText, accent)
      : sampleText;
    const stylePrompt =
      isGemini || !modelSupportsStyleInstructions(model)
        ? undefined
        : resolveStylePrompt({
            catalogStylePrompt: catalog.stylePrompt,
            locale: catalog.locale,
            accent,
          });

    // Expressive row preview and Play both share this compare script.
    // A saved clip is the same for every listener of that twin ref.
    const expressiveCacheKey =
      sample === "compare" &&
      twinLock.status === "locked" &&
      providerId === "fish" &&
      !isGemini
        ? expressivePreviewCacheKey({
            catalogVoiceId: catalog.id,
            referenceId: providerVoiceId,
            model,
            script: text,
          })
        : null;

    if (expressiveCacheKey) {
      const saved = await readExpressivePreviewCache(expressiveCacheKey);
      if (saved) {
        return previewAudioResponse(saved, "audio/mpeg", "hit");
      }
    }

    let result = await provider.synthesize({
      text,
      voiceId: providerVoiceId,
      catalogVoiceId: catalog.id,
      language: catalog.locale,
      model,
      stylePrompt,
    });

    // Retry once with plain text if the provider returned silence
    if (isEmptyOrSilentAudio(result.audio)) {
      console.warn(
        `[tts/preview] empty audio for ${catalogVoiceId}; retrying plain text`
      );
      result = await provider.synthesize({
        text: sample === "compare" ? sampleText : PREVIEW_TEXT,
        voiceId: providerVoiceId,
        catalogVoiceId: catalog.id,
        language: catalog.locale,
        model,
      });
    }

    if (isEmptyOrSilentAudio(result.audio)) {
      return NextResponse.json(
        {
          error:
            "Preview audio came back empty. Try another narrator, or try again in a moment.",
        },
        { status: 502 }
      );
    }

    if (expressiveCacheKey) {
      await writeExpressivePreviewCache(
        expressiveCacheKey,
        result.audio,
        result.contentType
      );
      return previewAudioResponse(result.audio, result.contentType, "miss");
    }

    return previewAudioResponse(result.audio, result.contentType);
  } catch (error) {
    console.error("[tts/preview] error:", error);
    const raw = error instanceof Error ? error.message : "Preview failed";
    return NextResponse.json(
      { error: userFriendlyError(raw) },
      { status: 500 }
    );
  }
}
