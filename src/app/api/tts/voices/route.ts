import { NextRequest, NextResponse } from "next/server";
import { listCatalogVoices, getCatalogVoice } from "@/lib/tts/catalog";
import { estimatePriceEur } from "@/lib/tts/pricing";
import {
  estimateTakehomeWallClockSeconds,
  formatFriendlyGenerationEta,
} from "@/lib/tts/eta";
import { handleApiError } from "@/lib/errors";
import { isOpenRouterConfigured } from "@/lib/tts/providers";
import { isHdVoice, isPremiumHdEnabled } from "@/lib/tts/premium";
import {
  ACCENT_LABELS,
  VIBE_LABELS,
  curateListenVoices,
  dedupeByFriendlyName,
  preferBetterVoice,
  type EnrichedCatalogVoice,
} from "@/lib/tts/voice-persona";

type VoiceWithPrice = EnrichedCatalogVoice & {
  priceEstimate: {
    suggestedPriceEur: number;
    estimatedAudioHours: number;
    targetPriceEur: number;
  } | null;
  generationEta: {
    sections: number;
    seconds: number;
    label: string | null;
  } | null;
};

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

    let voices = await listCatalogVoices({
      provider,
      language,
      gender,
      q,
      hdEnabled,
    });

    const withPrice: VoiceWithPrice[] = voices.map((v) => {
      const price =
        charCount > 0 ? estimatePriceEur({ charCount, voice: v }) : null;
      const wall =
        charCount > 0
          ? estimateTakehomeWallClockSeconds({
              charCount,
              maxCharsPerRequest: v.maxCharsPerRequest,
              latencyClass: v.latencyClass,
            })
          : null;
      return {
        ...v,
        priceEstimate: price
          ? {
              suggestedPriceEur: price.suggestedPriceEur,
              estimatedAudioHours: price.estimatedAudioHours,
              targetPriceEur: price.targetPriceEur,
            }
          : null,
        generationEta: wall
          ? {
              sections: wall.sections,
              seconds: wall.seconds,
              label: formatFriendlyGenerationEta(wall.seconds),
            }
          : null,
      };
    });

    const listenVoices = curateListenVoices(withPrice, 12);
    // Full-book catalog: curated vendors only (allowlist); drop tiny-context leftovers
    const takehomeVoices = dedupeByFriendlyName(
      withPrice.filter((v) => v.takehomeRecommended !== false),
      preferBetterVoice
    );

    const accents = Array.from(
      new Set(takehomeVoices.map((v) => v.accent))
    ).sort((a, b) => ACCENT_LABELS[a].localeCompare(ACCENT_LABELS[b]));

    const vibes = Array.from(new Set(takehomeVoices.map((v) => v.vibe))).sort(
      (a, b) => VIBE_LABELS[a].localeCompare(VIBE_LABELS[b])
    );

    return NextResponse.json({
      voices: takehomeVoices,
      listenVoices,
      count: takehomeVoices.length,
      listenCount: listenVoices.length,
      accents: accents.map((id) => ({ id, label: ACCENT_LABELS[id] })),
      vibes: vibes.map((id) => ({ id, label: VIBE_LABELS[id] })),
      source: withPrice.some((v) => v.provider === "openrouter")
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

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    if (!isPremiumHdEnabled({ ip }) && isHdVoice(voice)) {
      return NextResponse.json({ error: "Voice not available" }, { status: 403 });
    }

    const charCount = Number(body.charCount || 0);
    const price =
      charCount > 0 ? estimatePriceEur({ charCount, voice }) : null;
    const wall =
      charCount > 0
        ? estimateTakehomeWallClockSeconds({
            charCount,
            maxCharsPerRequest: voice.maxCharsPerRequest,
            latencyClass: voice.latencyClass,
          })
        : null;
    return NextResponse.json({
      voice,
      priceEstimate: price,
      generationEta: wall
        ? {
            sections: wall.sections,
            seconds: wall.seconds,
            label: formatFriendlyGenerationEta(wall.seconds),
          }
        : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
