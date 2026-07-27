/**
 * Consumer-facing voice personas — turn raw OpenRouter/model voice IDs
 * into accents, vibes, and friendly names people actually understand.
 */

import type { CatalogVoice, Gender, LatencyClass } from "@/lib/tts/types";

export type VoiceAccent =
  | "american"
  | "british"
  | "australian"
  | "irish"
  | "other";

export type VoiceVibe =
  | "calm"
  | "warm"
  | "upbeat"
  | "smooth"
  | "dramatic"
  | "clear";

export const ACCENT_LABELS: Record<VoiceAccent, string> = {
  american: "American",
  british: "British",
  australian: "Australian",
  irish: "Irish",
  other: "Other accents",
};

export const VIBE_LABELS: Record<VoiceVibe, string> = {
  calm: "Calm",
  warm: "Warm",
  upbeat: "Upbeat",
  smooth: "Smooth",
  dramatic: "Dramatic",
  clear: "Clear",
};

export const GENDER_LABELS: Record<Gender, string> = {
  female: "Female",
  male: "Male",
  neutral: "Neutral",
};

/** Strip provider / model suffixes into a first-name style label. */
export function friendlyVoiceName(voice: CatalogVoice): string {
  const raw =
    voice.providerVoiceId.includes(":")
      ? voice.providerVoiceId.split(":")[0] || voice.providerVoiceId
      : voice.providerVoiceId;

  let name = raw
    .replace(/^aura-2-/i, "")
    .replace(/^en-US-/i, "")
    .replace(/^en-GB-/i, "")
    .replace(/^en-AU-/i, "")
    .replace(/-en$/i, "")
    .replace(/Neural2-/i, "")
    .replace(/Wavenet-/i, "")
    .replace(/Standard-/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  // If displayName is already short and clean, prefer its first segment
  const displayFirst = (voice.displayName.split("·")[0] || "").trim();
  if (displayFirst && displayFirst.length < 40 && !/\//.test(displayFirst)) {
    name = displayFirst.replace(/[_-]+/g, " ").trim() || name;
  }

  // Title-case words
  name = name
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");

  return name || "Narrator";
}

export function inferAccent(voice: CatalogVoice): VoiceAccent {
  // Do NOT include qualityNotes / model description — shared across all voices
  // of a model and poisons accent labels.
  const hay = `${voice.locale} ${voice.providerVoiceId} ${voice.displayName} ${voice.tags.join(" ")}`.toLowerCase();
  const id = voice.providerVoiceId.toLowerCase();

  // Kokoro-style prefixes win over vague English defaults
  if (/^b[fm][_-]/.test(id) || id.includes("british")) return "british";
  if (/^a[fm][_-]/.test(id) || id.includes("american")) return "american";
  if (id.includes("australian") || /^au[_-]/.test(id)) return "australian";
  if (id.includes("irish") || /^ie[_-]/.test(id)) return "irish";

  if (
    /en-gb|en_gb|british|uk[-_ ]|london|england|scotland|welsh|britain|rp\b/.test(
      hay
    )
  ) {
    return "british";
  }
  if (/en-au|en_au|australian|australia|sydney|melbourne/.test(hay)) {
    return "australian";
  }
  if (/en-ie|en_ie|irish|ireland|dublin/.test(hay)) {
    return "irish";
  }
  if (
    /en-us|en_us|american|usa|united states|california|new york|texas/.test(hay) ||
    voice.locale.toLowerCase().startsWith("en-us")
  ) {
    return "american";
  }
  if (voice.locale.toLowerCase().startsWith("en-gb")) return "british";
  if (voice.language.toLowerCase() === "english" || voice.locale.startsWith("en")) {
    return "american"; // default English → American when unspecified
  }
  return "other";
}

export function inferVibe(voice: CatalogVoice): VoiceVibe {
  const hay = `${voice.style} ${voice.tags.join(" ")} ${voice.qualityNotes || ""} ${voice.providerVoiceId} ${voice.displayName}`.toLowerCase();

  if (/dramatic|intense|strong|bold|powerful|epic|theatrical/.test(hay)) {
    return "dramatic";
  }
  if (/upbeat|bright|energetic|cheerful|lively|playful|fun|spark/.test(hay)) {
    return "upbeat";
  }
  if (/warm|storytelling|friendly|gentle|soft|cozy|intimate/.test(hay)) {
    return "warm";
  }
  if (/smooth|silky|velvety|sultry|elegant|refined/.test(hay)) {
    return "smooth";
  }
  if (/calm|deep|soothing|relax|meditat|serene|quiet|steady/.test(hay)) {
    return "calm";
  }
  if (/clear|neutral|professional|news|standard|narrat/.test(hay)) {
    return "clear";
  }

  // Name-based heuristics for common stock voices
  const id = voice.providerVoiceId.toLowerCase();
  if (/charon|onyx|echo|fenrir|orion|atlas/.test(id)) return "calm";
  if (/aoede|nova|shimmer|kore|alloy|luna|hera/.test(id)) return "warm";
  if (/puck|fable|spark|asteria/.test(id)) return "upbeat";
  if (/eve|ara|harper|valeria/.test(id)) return "smooth";

  return voice.style === "expressive" ? "warm" : "clear";
}

/**
 * Live Listen should only offer fast, reliable narrators from the curated set.
 * Prefer flash/turbo Gemini, Microsoft, Qwen, Grok; exclude HD Minimax.
 */
export function isListenFriendly(voice: CatalogVoice): boolean {
  const model = voice.model.toLowerCase();
  if (model.includes("minimax") || voice.tags.some((t) => t.toLowerCase() === "hd")) {
    return false;
  }
  if (model.includes("zonos") || model.includes("kokoro")) return false;
  if (voice.latencyClass === "fast") return true;
  if (model.includes("flash") || model.includes("turbo")) return true;
  if (model.includes("gemini")) return true;
  // Static / direct gemini + grok are fine for listen
  if (voice.provider === "google" || voice.provider === "gemini" || voice.provider === "grok") {
    return true;
  }
  // Grok on OpenRouter (x-ai) is balanced but solid for live listen
  if (model.includes("grok") || model.includes("x-ai")) return true;
  return voice.latencyClass === "balanced" && voice.maxCharsPerRequest >= 800;
}

/**
 * Full audiobook voices need decent chunk size and must be on the allowlist.
 */
export function isTakehomeFriendly(voice: CatalogVoice): boolean {
  if (voice.model.toLowerCase().includes("zonos")) return false;
  if (voice.model.toLowerCase().includes("kokoro")) return false;
  if (voice.maxCharsPerRequest > 0 && voice.maxCharsPerRequest < 600) return false;
  return true;
}

export function personaSubtitle(voice: CatalogVoice): string {
  const accent = ACCENT_LABELS[inferAccent(voice)];
  const gender = GENDER_LABELS[voice.gender];
  const vibe = VIBE_LABELS[inferVibe(voice)];
  return `${accent} · ${gender} · ${vibe}`;
}

export type EnrichedCatalogVoice = CatalogVoice & {
  friendlyName: string;
  accent: VoiceAccent;
  vibe: VoiceVibe;
  personaLabel: string;
  listenRecommended: boolean;
  takehomeRecommended: boolean;
};

export function enrichCatalogVoice(voice: CatalogVoice): EnrichedCatalogVoice {
  const accent = inferAccent(voice);
  const vibe = inferVibe(voice);
  const friendlyName = friendlyVoiceName(voice);
  return {
    ...voice,
    friendlyName,
    accent,
    vibe,
    personaLabel: `${ACCENT_LABELS[accent]} · ${GENDER_LABELS[voice.gender]} · ${VIBE_LABELS[vibe]}`,
    listenRecommended: isListenFriendly(voice),
    takehomeRecommended: isTakehomeFriendly(voice),
    // Prefer consumer name everywhere UI shows displayName
    displayName: friendlyName,
    style: vibe,
    tags: Array.from(
      new Set([
        ...voice.tags,
        accent,
        vibe,
        voice.gender,
        ACCENT_LABELS[accent].toLowerCase(),
      ])
    ),
  };
}

export function enrichCatalogVoices(
  voices: CatalogVoice[]
): EnrichedCatalogVoice[] {
  return voices.map(enrichCatalogVoice);
}

/**
 * Curate a short Listen menu: one voice per accent×gender×vibe bucket,
 * prefer cheaper/faster models, cap the list.
 */
export function curateListenVoices(
  voices: EnrichedCatalogVoice[],
  limit = 12
): EnrichedCatalogVoice[] {
  const candidates = voices
    .filter((v) => v.listenRecommended)
    .filter((v) => v.language.toLowerCase() === "english" || v.locale.startsWith("en"))
    .sort((a, b) => {
      const rank = (v: EnrichedCatalogVoice) => {
        let score = 0;
        if (v.latencyClass === "fast") score += 30;
        if (v.latencyClass === "balanced") score += 15;
        if (v.model.includes("gemini")) score += 20;
        if (v.model.includes("microsoft")) score += 12;
        if (v.model.includes("qwen") && v.model.includes("flash")) score += 10;
        if (v.model.includes("grok") || v.model.includes("x-ai")) score += 10;
        score -= Math.min(20, (v.usdPerMillionChars || 5) / 2);
        return score;
      };
      return rank(b) - rank(a);
    });

  const seen = new Set<string>();
  const picked: EnrichedCatalogVoice[] = [];

  for (const v of candidates) {
    const key = `${v.accent}:${v.gender}:${v.vibe}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(v);
    if (picked.length >= limit) break;
  }

  // If still thin, fill with best remaining listen-friendly voices
  if (picked.length < Math.min(limit, 8)) {
    for (const v of candidates) {
      if (picked.some((p) => p.id === v.id)) continue;
      picked.push(v);
      if (picked.length >= limit) break;
    }
  }

  return picked;
}

export function groupLabelForBrowse(voice: EnrichedCatalogVoice): string {
  if (voice.accent === "other") {
    return voice.language !== "English" ? voice.language : ACCENT_LABELS.other;
  }
  return `${ACCENT_LABELS[voice.accent]} ${GENDER_LABELS[voice.gender]}`;
}

export function sortBrowseGroups(a: string, b: string): number {
  const order = [
    "American Female",
    "American Male",
    "American Neutral",
    "British Female",
    "British Male",
    "British Neutral",
    "Australian Female",
    "Australian Male",
    "Irish Female",
    "Irish Male",
  ];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a.localeCompare(b);
}

/** Deduplicate near-identical friendly names within a group for Full book. */
export function dedupeByFriendlyName(
  voices: EnrichedCatalogVoice[],
  prefer: (a: EnrichedCatalogVoice, b: EnrichedCatalogVoice) => EnrichedCatalogVoice
): EnrichedCatalogVoice[] {
  const map = new Map<string, EnrichedCatalogVoice>();
  for (const v of voices) {
    const key = `${v.friendlyName.toLowerCase()}:${v.accent}:${v.gender}`;
    const existing = map.get(key);
    map.set(key, existing ? prefer(existing, v) : v);
  }
  return Array.from(map.values());
}

export function preferBetterVoice(
  a: EnrichedCatalogVoice,
  b: EnrichedCatalogVoice
): EnrichedCatalogVoice {
  const score = (v: EnrichedCatalogVoice) => {
    let s = 0;
    if (v.recommendedForLongForm) s += 10;
    if (v.latencyClass === "quality") s += 5;
    if (v.model.includes("minimax")) s += 8;
    if (v.model.includes("gemini")) s += 8;
    if (v.model.includes("microsoft")) s += 5;
    if (v.model.includes("qwen")) s += 4;
    if (v.model.includes("grok") || v.model.includes("x-ai")) s += 4;
    s -= Math.min(15, (v.usdPerMillionChars || 0) / 3);
    return s;
  };
  return score(b) > score(a) ? b : a;
}

export function latencyLabel(cls: LatencyClass): string | null {
  if (cls === "fast") return "Starts quickly";
  if (cls === "quality") return "Richer voice";
  return null;
}
