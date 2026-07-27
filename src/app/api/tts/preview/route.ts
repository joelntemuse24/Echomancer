import { NextRequest, NextResponse } from "next/server";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import { createRateLimiter } from "@/lib/rate-limit";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";
import { userFriendlyError } from "@/lib/errors-ui";

export const runtime = "nodejs";
export const maxDuration = 30;

const PREVIEW_TEXT =
  "The first chapter of an audiobook sets the tone. Listen to this sample to hear how the narrator sounds.";

// Browsing narrators needs more than 5 previews/min
const previewRateLimit = createRateLimiter(15, 60_000);

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!(await previewRateLimit(ip))) {
      return NextResponse.json(
        { error: "You're previewing too quickly. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { catalogVoiceId } = body as { catalogVoiceId?: string };

    if (!catalogVoiceId) {
      return NextResponse.json(
        { error: "Please select a narrator to preview." },
        { status: 400 }
      );
    }

    const catalog = await getCatalogVoice(catalogVoiceId, { hdEnabled: true });
    if (!catalog) {
      return NextResponse.json(
        { error: "That narrator isn't available right now." },
        { status: 404 }
      );
    }

    if (isHdVoice(catalog) && !isPremiumHdEnabled({ ip })) {
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
    });

    const { resolveStylePrompt } = await import("@/lib/tts/resolve-style-prompt");
    const result = await provider.synthesize({
      text: PREVIEW_TEXT,
      voiceId: catalog.providerVoiceId,
      language: catalog.locale,
      model: catalog.model,
      stylePrompt: resolveStylePrompt({
        catalogStylePrompt: catalog.stylePrompt,
        locale: catalog.locale,
      }),
    });

    return new NextResponse(new Uint8Array(result.audio), {
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "public, max-age=86400",
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
