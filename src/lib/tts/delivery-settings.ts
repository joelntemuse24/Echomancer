/**
 * Whole-book delivery knobs: adaptive defaults from the text, plus optional
 * user overrides. No LLM. No essay-specific word lists.
 */

import { isDenseAcademicText } from "@/lib/tts/narration-pace";
import {
  isAllCapsTitleLine,
  isRomanSectionLine,
} from "@/lib/tts/normalize-speakable";
import { splitSentences } from "@/lib/tts/speakable-text";
import {
  CROSSFADE_MS_DEFAULT,
  clampCrossfadeMs,
} from "@/lib/tts/crossfade-audio";

export type PauseStyle = "sparse" | "normal";
export type AutoOr<T> = T | "auto";
export type DeliverySource = "adaptive" | "user";

export type DeliveryUserInput = {
  pauseStyle?: AutoOr<PauseStyle>;
  crossfadeMs?: AutoOr<number>;
  normalizeTitles?: AutoOr<boolean>;
  deliveryPrefix?: AutoOr<boolean>;
};

export type ResolvedDeliverySettings = {
  pauseStyle: PauseStyle;
  crossfadeMs: number;
  normalizeTitles: boolean;
  deliveryPrefix: boolean;
  source: {
    pauseStyle: DeliverySource;
    crossfadeMs: DeliverySource;
    normalizeTitles: DeliverySource;
    deliveryPrefix: DeliverySource;
  };
};

export type SpeakableFeatures = {
  chars: number;
  paragraphs: number;
  sentenceCount: number;
  avgCharsPerSentence: number;
  punctPerHundred: number;
  allCapsLines: number;
  romanLines: number;
  quoteRatio: number;
  denseAcademic: boolean;
};

export function measureSpeakableFeatures(text: string): SpeakableFeatures {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const cleaned = text.replace(/\s+/g, " ").trim();
  const sentences = splitSentences(cleaned);
  const avgCharsPerSentence = sentences.length
    ? cleaned.length / sentences.length
    : cleaned.length;
  const punct = (cleaned.match(/[.;:!?]/g) || []).length;
  const quotes = (cleaned.match(/["“”]/g) || []).length;
  return {
    chars: cleaned.length,
    paragraphs: paragraphs.length,
    sentenceCount: sentences.length,
    avgCharsPerSentence,
    punctPerHundred: cleaned.length ? (punct / cleaned.length) * 100 : 0,
    allCapsLines: paragraphs.filter(isAllCapsTitleLine).length,
    romanLines: paragraphs.filter(isRomanSectionLine).length,
    quoteRatio: cleaned.length ? quotes / cleaned.length : 0,
    denseAcademic: isDenseAcademicText(text),
  };
}

export function adaptDeliverySettings(text: string): ResolvedDeliverySettings {
  const f = measureSpeakableFeatures(text);
  const pauseStyle: PauseStyle =
    f.denseAcademic || f.avgCharsPerSentence >= 100
      ? "normal"
      : "sparse";

  let crossfadeMs = CROSSFADE_MS_DEFAULT;
  if (f.chars < 4_000) crossfadeMs = 80;
  else if (f.chars > 80_000) crossfadeMs = 140;

  const glued = f.paragraphs <= 2 && f.chars > 500;
  const normalizeTitles = f.allCapsLines > 0 || f.romanLines > 0 || glued;

  const conversational =
    f.avgCharsPerSentence < 75 && f.quoteRatio >= 0.01 && !f.denseAcademic;
  const deliveryPrefix =
    !conversational && (f.denseAcademic || f.avgCharsPerSentence >= 90 || f.chars > 2_000);

  return {
    pauseStyle,
    crossfadeMs,
    normalizeTitles,
    deliveryPrefix,
    source: {
      pauseStyle: "adaptive",
      crossfadeMs: "adaptive",
      normalizeTitles: "adaptive",
      deliveryPrefix: "adaptive",
    },
  };
}

function isAuto(value: unknown): boolean {
  return value === undefined || value === null || value === "auto";
}

export function resolveDeliverySettings(
  text: string,
  user?: DeliveryUserInput | null
): ResolvedDeliverySettings {
  const adapted = adaptDeliverySettings(text);
  const pauseUser = !isAuto(user?.pauseStyle) && (user?.pauseStyle === "sparse" || user?.pauseStyle === "normal");
  const fadeUser =
    typeof user?.crossfadeMs === "number" && Number.isFinite(user.crossfadeMs);
  const titlesUser = typeof user?.normalizeTitles === "boolean";
  const prefixUser = typeof user?.deliveryPrefix === "boolean";

  return {
    pauseStyle: pauseUser ? user!.pauseStyle as PauseStyle : adapted.pauseStyle,
    crossfadeMs: fadeUser
      ? clampCrossfadeMs(user!.crossfadeMs as number)
      : adapted.crossfadeMs,
    normalizeTitles: titlesUser ? user!.normalizeTitles as boolean : adapted.normalizeTitles,
    deliveryPrefix: prefixUser ? user!.deliveryPrefix as boolean : adapted.deliveryPrefix,
    source: {
      pauseStyle: pauseUser ? "user" : "adaptive",
      crossfadeMs: fadeUser ? "user" : "adaptive",
      normalizeTitles: titlesUser ? "user" : "adaptive",
      deliveryPrefix: prefixUser ? "user" : "adaptive",
    },
  };
}

export function deliveryUserInputFromUnknown(
  raw: unknown
): DeliveryUserInput {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: DeliveryUserInput = {};
  if (o.pauseStyle === "sparse" || o.pauseStyle === "normal" || o.pauseStyle === "auto") {
    out.pauseStyle = o.pauseStyle;
  }
  if (o.crossfadeMs === "auto") out.crossfadeMs = "auto";
  else if (typeof o.crossfadeMs === "number") out.crossfadeMs = o.crossfadeMs;
  if (o.normalizeTitles === "auto") out.normalizeTitles = "auto";
  else if (typeof o.normalizeTitles === "boolean") out.normalizeTitles = o.normalizeTitles;
  if (o.deliveryPrefix === "auto") out.deliveryPrefix = "auto";
  else if (typeof o.deliveryPrefix === "boolean") out.deliveryPrefix = o.deliveryPrefix;
  return out;
}
