import { NextRequest, NextResponse } from "next/server";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";

export const runtime = "nodejs";
export const maxDuration = 30;

const PREVIEW_TEXT =
  "The first chapter of an audiobook sets the tone. Listen to this sample to hear how the narrator sounds.";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { catalogVoiceId } = body as { catalogVoiceId?: string };

    if (!catalogVoiceId) {
      return NextResponse.json(
        { error: "catalogVoiceId is required" },
        { status: 400 }
      );
    }

    const catalog = await getCatalogVoice(catalogVoiceId);
    if (!catalog) {
      return NextResponse.json(
        { error: "Voice not found in catalog" },
        { status: 404 }
      );
    }

    const providerId = catalog.provider;
    if (!isStockProvider(providerId)) {
      return NextResponse.json(
        { error: `Provider ${providerId} not supported` },
        { status: 400 }
      );
    }

    const provider = resolveStockAdapter({
      provider: providerId,
      model: catalog.model,
    });

    const result = await provider.synthesize({
      text: PREVIEW_TEXT,
      voiceId: catalog.providerVoiceId,
      language: catalog.locale,
      model: catalog.model,
      stylePrompt:
        "Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.",
    });

    return new NextResponse(new Uint8Array(result.audio), {
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("[tts/preview] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Preview failed" },
      { status: 500 }
    );
  }
}
