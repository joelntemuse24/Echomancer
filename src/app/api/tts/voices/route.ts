import { NextRequest, NextResponse } from "next/server";
import { listCatalogVoices } from "@/lib/tts/catalog";
import { estimatePriceEur, TARGET_PRICE_EUR } from "@/lib/tts/pricing";
import {
  estimateTakehomeWallClockSeconds,
  formatFriendlyGenerationEta,
} from "@/lib/tts/eta";
import { handleApiError } from "@/lib/errors";
import { isOpenRouterConfigured } from "@/lib/tts/providers";
import { isPremiumHdEnabled } from "@/lib/tts/premium";
import { isResearchPreviewConfigured } from "@/lib/tts/research-preview";
import { readSession } from "@/lib/auth/session";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
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

export const runtime = "nodejs";

// A cache miss fans out to OpenRouter's model listing, so the catalog is worth
// metering; it fails closed to keep that fan-out bounded.
const catalogRateLimit = createRateLimiter(60, 60_000, { onError: "closed" });

export async function GET(request: NextRequest) {
  try {
    const session = await readSession(request);
    const ip = clientIp(request);
    if (
      !(await catalogRateLimit(
        await rateLimitIdentity({ userId: session?.userId, ip })
      ))
    ) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a moment." },
        { status: 429 }
      );
    }

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || undefined;
    const language = searchParams.get("language") || undefined;
    const gender = searchParams.get("gender") || undefined;
    const q = searchParams.get("q")?.slice(0, 100) || undefined;
    const charCount = Math.max(
      0,
      Math.min(Number(searchParams.get("charCount") || "0") || 0, 50_000_000)
    );

    const hdEnabled = isPremiumHdEnabled({ ip, userId: session?.userId });

    const voices = await listCatalogVoices({
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

    const slimTestCatalog = isResearchPreviewConfigured();

    // Free API test mode: catalog is already Storyteller + Gemini Kore only.
    // Skip OpenRouter-style curation so both options stay visible.
    const listenVoices = slimTestCatalog
      ? withPrice
      : curateListenVoices(withPrice, 12);
    const takehomeVoices = slimTestCatalog
      ? withPrice
      : dedupeByFriendlyName(
          withPrice.filter((v) => v.takehomeRecommended !== false),
          preferBetterVoice
        );

    const accents = Array.from(
      new Set(takehomeVoices.map((v) => v.accent))
    ).sort((a, b) => ACCENT_LABELS[a].localeCompare(ACCENT_LABELS[b]));

    const vibes = Array.from(new Set(takehomeVoices.map((v) => v.vibe))).sort(
      (a, b) => VIBE_LABELS[a].localeCompare(VIBE_LABELS[b])
    );

    const source = slimTestCatalog
      ? "research"
      : withPrice.some((v) => v.provider === "openrouter")
        ? "openrouter"
        : "static";

    return NextResponse.json({
      voices: takehomeVoices,
      listenVoices,
      count: takehomeVoices.length,
      listenCount: listenVoices.length,
      accents: accents.map((id) => ({ id, label: ACCENT_LABELS[id] })),
      vibes: vibes.map((id) => ({ id, label: VIBE_LABELS[id] })),
      source,
      openRouterKeyConfigured: isOpenRouterConfigured(),
      researchPreview: slimTestCatalog,
      targetPriceEur: TARGET_PRICE_EUR,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
