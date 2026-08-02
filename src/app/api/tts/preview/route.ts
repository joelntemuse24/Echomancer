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
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import { inferAccent } from "@/lib/tts/voice-persona";
import {
  geminiDirectedInput,
  modelSupportsAccentVariants,
  modelSupportsStyleInstructions,
} from "@/lib/tts/accent-prompt";
import { readSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const maxDuration = 30;

// Comparing narrators needs more than a handful per minute, but each preview is
// a paid synthesis call, so the limiter fails closed.
const previewRateLimit = createRateLimiter(15, 60_000, { onError: "closed" });

export async function POST(request: NextRequest) {
  try {
    const session = await readSession(request);
    const ip = clientIp(request);
    if (
      !(await previewRateLimit(
        await rateLimitIdentity({ userId: session?.userId, ip })
      ))
    ) {
      return NextResponse.json(
        { error: "You're previewing too quickly. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { catalogVoiceId } = body as { catalogVoiceId?: string };

    if (!catalogVoiceId || typeof catalogVoiceId !== "string") {
      return NextResponse.json(
        { error: "Please select a narrator to preview." },
        { status: 400 }
      );
    }

    const catalog = await getCatalogVoice(catalogVoiceId, {
      hdEnabled: true,
      userId: session?.userId,
    });
    if (!catalog) {
      return NextResponse.json(
        { error: "That narrator isn't available right now." },
        { status: 404 }
      );
    }

    // Research Free API voices skip the paid HD gate; OpenRouter HD still uses it.
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

    const providerId = catalog.provider;
    if (!isStockProvider(providerId)) {
      return NextResponse.json(
        { error: "That narrator isn't supported." },
        { status: 400 }
      );
    }

    const provider = resolveStockAdapter({
      provider: providerId,
      model: catalog.model,
      catalogVoiceId: catalog.id,
    });

    const { resolveStylePrompt } = await import("@/lib/tts/resolve-style-prompt");
    const accent =
      catalog.accentHint ||
      (catalog as { accent?: string }).accent ||
      inferAccent(catalog);

    const isGemini = modelSupportsAccentVariants(catalog.model);
    // Gemini: put accent in the input (Google's documented pattern).
    // Avoid a separate aggressive `prompt` — it was returning empty PCM.
    // Other vendors only get a style prompt when they actually honour it.
    const text = isGemini
      ? geminiDirectedInput(PREVIEW_TEXT, accent)
      : PREVIEW_TEXT;
    const stylePrompt =
      isGemini || !modelSupportsStyleInstructions(catalog.model)
        ? undefined
        : resolveStylePrompt({
            catalogStylePrompt: catalog.stylePrompt,
            locale: catalog.locale,
            accent,
          });

    let result = await provider.synthesize({
      text,
      voiceId: catalog.providerVoiceId,
      language: catalog.locale,
      model: catalog.model,
      stylePrompt,
    });

    // Retry once with plain text if the provider returned silence
    if (isEmptyOrSilentAudio(result.audio)) {
      console.warn(
        `[tts/preview] empty audio for ${catalogVoiceId}; retrying plain text`
      );
      result = await provider.synthesize({
        text: PREVIEW_TEXT,
        voiceId: catalog.providerVoiceId,
        language: catalog.locale,
        model: catalog.model,
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

    return new NextResponse(new Uint8Array(result.audio), {
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[tts/preview] error:", error);
    const raw = error instanceof Error ? error.message : "Preview failed";
    return NextResponse.json(
      { error: userFriendlyError(raw) },
      { status: 500 }
    );
  }
}
