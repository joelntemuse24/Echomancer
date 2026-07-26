import { NextRequest, NextResponse } from "next/server";
import { listCatalogVoices, getCatalogVoice } from "@/lib/tts/catalog";
import { estimatePriceEur } from "@/lib/tts/pricing";
import { handleApiError } from "@/lib/errors";
import { isOpenRouterConfigured } from "@/lib/tts/providers";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || undefined;
    const language = searchParams.get("language") || undefined;
    const gender = searchParams.get("gender") || undefined;
    const q = searchParams.get("q") || undefined;
    const charCount = Number(searchParams.get("charCount") || "0");

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    const hdEnabled = isPremiumHdEnabled({ ip });

    // Filter out HD voices when premium is not enabled
    let voices = await listCatalogVoices({
      provider,
      language,
      gender,
      q,
      hdEnabled,
    });

    voices = voices.map((v) => {
        const price =
          charCount > 0 ? estimatePriceEur({ charCount, voice: v }) : null;
        return {
          ...v,
          priceEstimate: price
            ? {
                suggestedPriceEur: price.suggestedPriceEur,
                estimatedAudioHours: price.estimatedAudioHours,
                ttsCogsUsd: price.ttsCogsUsd,
                targetPriceEur: price.targetPriceEur,
              }
            : null,
        };
      }
    );

    // Distinct model slugs for UI filter chips
    const models = Array.from(new Set(voices.map((v) => v.model))).sort();
    const vendors = Array.from(
      new Set(voices.map((v) => v.model.split("/")[0] || v.provider))
    ).sort();

    return NextResponse.json({
      voices,
      count: voices.length,
      models,
      vendors,
      source: voices.some((v) => v.provider === "openrouter")
        ? "openrouter"
        : "static",
      openRouterKeyConfigured: isOpenRouterConfigured(),
      targetPriceEur: 4.5,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const id = body.id as string;
    const voice = await getCatalogVoice(id, { hdEnabled: true });
    if (!voice) {
      return NextResponse.json({ error: "Voice not found" }, { status: 404 });
    }

    // M7: Apply HD filter on single-voice lookup too
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    if (!isPremiumHdEnabled({ ip }) && isHdVoice(voice)) {
      return NextResponse.json({ error: "Voice not available" }, { status: 403 });
    }

    const charCount = Number(body.charCount || 0);
    const price =
      charCount > 0 ? estimatePriceEur({ charCount, voice }) : null;
    return NextResponse.json({ voice, priceEstimate: price });
  } catch (error) {
    return handleApiError(error);
  }
}
