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
export function stripVoiceIdDecorations(raw: string): string {
  let name = raw.trim();
  // Drop trailing provider qualifiers: "en-US-Harper:MAI-Voice-2" → "en-US-Harper"
  if (name.includes(":")) name = name.split(":")[0] || name;

  // Strip leading BCP-47 locale prefixes (en-US-, de-DE-, es-MX-, fr-FR-, …)
  name = name.replace(/^[a-z]{2}-[A-Za-z]{2}-/i, "");
  // Also catch already-spaced "en US Harper" / "En Us Harper"
  name = name.replace(/^[a-z]{2}\s+[A-Za-z]{2}\s+/i, "");

  name = name
    .replace(/^aura-2-/i, "")
    .replace(/-en$/i, "")
    .replace(/Neural2-/i, "")
    .replace(/Wavenet-/i, "")
    .replace(/Standard-/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  return name;
}

export function friendlyVoiceName(voice: CatalogVoice): string {
  const fromId = stripVoiceIdDecorations(voice.providerVoiceId);
  const displayFirst = stripVoiceIdDecorations(
    (voice.displayName.split("·")[0] || "").trim()
  );

  // Prefer the cleaner of the two — never keep locale leftovers like "En Us"
  let name = fromId;
  if (
    displayFirst &&
    displayFirst.length < 40 &&
    !/\//.test(displayFirst) &&
    !/^[a-z]{2}\s+[a-z]{2}\b/i.test(displayFirst)
  ) {
    // Use display only when it doesn't look like a raw id with locale junk
    const displayLooksClean =
      displayFirst.length <= fromId.length + 4 ||
      !/^(en|es|fr|de|it|nl|ja|zh|pt)\b/i.test(displayFirst);
    if (displayLooksClean) name = displayFirst || fromId;
  }

  // Prefer short given-name style from cleaned id when display is still messy
  if (/^(en|es|fr|de|it|nl|ja|zh|pt)\s/i.test(name) && fromId) {
    name = fromId;
  }

  name = name
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");

  return name || "Narrator";
}

export function inferAccent(voice: CatalogVoice): VoiceAccent {
  // Explicit catalog accent wins (Gemini variants, seeded Minimax, etc.)
  if (voice.accentHint && voice.accentHint in ACCENT_LABELS) {
    return voice.accentHint;
  }

  // Do NOT include qualityNotes / model description — shared across all voices
  // of a model and poisons accent labels.
  const hay = `${voice.locale} ${voice.providerVoiceId} ${voice.displayName} ${voice.tags.join(" ")}`.toLowerCase();
  const id = voice.providerVoiceId.toLowerCase();
  const locale = voice.locale.toLowerCase();

  // Locale is the most trustworthy signal when present
  if (locale.startsWith("en-gb")) return "british";
  if (locale.startsWith("en-au")) return "australian";
  if (locale.startsWith("en-ie")) return "irish";
  if (locale.startsWith("en-us")) return "american";
  if (locale.startsWith("en-") && locale !== "en") {
    // other English locales (en-IN, en-ZA, …) — don't force American
    if (/gb|uk|ie|au|nz|in|za|sg/.test(locale)) {
      if (locale.includes("gb") || locale.includes("uk")) return "british";
      if (locale.includes("au") || locale.includes("nz")) return "australian";
      if (locale.includes("ie")) return "irish";
    }
  }

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
    /en-us|en_us|american|usa|united states|california|new york|texas/.test(hay)
  ) {
    return "american";
  }
  if (voice.language.toLowerCase() === "english" || locale.startsWith("en")) {
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
  const baseName = friendlyVoiceName(voice);
  // Put accent in the title so the picker isn't a wall of identical American-looking names
  const english =
    voice.language.toLowerCase() === "english" ||
    voice.locale.toLowerCase().startsWith("en");
  const friendlyName =
    english && accent !== "other" && !baseName.includes(ACCENT_LABELS[accent])
      ? `${baseName} · ${ACCENT_LABELS[accent]}`
      : baseName;
  return {
    ...voice,
    accentHint: voice.accentHint ?? accent,
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
        ...voice.tags.filter(
          // Drop stale accent tags from a previous enrich pass so they can't
          // poison a different accent variant on re-enrich.
          (t) =>
            !["american", "british", "australian", "irish", "other"].includes(
              t.toLowerCase()
            ) &&
            !["american", "british", "australian", "irish", "other accents"].includes(
              t.toLowerCase()
            )
        ),
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
 * Curate a short Listen menu: accent × gender diversity with distinct
 * underlying voices (don't list Achernar four times as four "accents").
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
        // Prefer real locale-native accents slightly over prompt-steered duplicates
        if (v.providerVoiceId.toLowerCase().includes(v.locale.toLowerCase())) {
          score += 8;
        }
        score -= Math.min(20, (v.usdPerMillionChars || 5) / 2);
        return score;
      };
      return rank(b) - rank(a);
    });

  const seenBuckets = new Set<string>();
  const seenVoices = new Set<string>();
  const accentCounts: Record<string, number> = {};
  const picked: EnrichedCatalogVoice[] = [];

  for (const v of candidates) {
    const voiceKey = v.providerVoiceId.toLowerCase();
    if (seenVoices.has(voiceKey)) continue;

    const bucket = `${v.accent}:${v.gender}`;
    // Soft preference: don't flood one accent early
    if ((accentCounts[v.accent] || 0) >= 3 && picked.length < limit - 2) {
      continue;
    }
    if (seenBuckets.has(bucket) && picked.length >= Math.min(6, limit)) {
      continue;
    }

    seenVoices.add(voiceKey);
    seenBuckets.add(bucket);
    accentCounts[v.accent] = (accentCounts[v.accent] || 0) + 1;
    picked.push(v);
    if (picked.length >= limit) break;
  }

  // If still thin, fill with best remaining listen-friendly voices (still unique)
  if (picked.length < Math.min(limit, 8)) {
    for (const v of candidates) {
      const voiceKey = v.providerVoiceId.toLowerCase();
      if (seenVoices.has(voiceKey)) continue;
      seenVoices.add(voiceKey);
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
