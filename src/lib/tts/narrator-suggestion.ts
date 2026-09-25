/**
 * Product rules for a stock narrator suggestion.
 * Safe in the voice picker: no network, no storage, no book text.
 */

import type { StockDeliveryMode } from "@/lib/tts/stock-delivery";

const STOCK_IDS = ["standard", "michelle", "clara", "randolph"] as const;
export type NarratorCatalogVoiceId = (typeof STOCK_IDS)[number];

export type NarratorKind =
  | "article"
  | "biography"
  | "history"
  | "nonfiction"
  | "novel";

export type NarratorRecommendation = {
  catalogVoiceId: NarratorCatalogVoiceId;
  delivery: StockDeliveryMode;
  kind: NarratorKind;
  novelKind: string | null;
  kindLabel: string;
};

const KIND_LABEL: Record<Exclude<NarratorKind, "novel">, string> = {
  article: "Article",
  biography: "Biography",
  history: "History",
  nonfiction: "Nonfiction",
};

function isStockId(value: string): value is NarratorCatalogVoiceId {
  return (STOCK_IDS as readonly string[]).includes(value);
}

function kindLabelFor(kind: NarratorKind, novelKind: string | null): string {
  if (kind !== "novel") return KIND_LABEL[kind];
  const named = (novelKind || "").replace(/\s+/g, " ").trim();
  if (!named) return "Novel";
  return named.charAt(0).toUpperCase() + named.slice(1);
}

/**
 * Enforce the product rules. The model may not move nonfiction off Andrew,
 * history off Randolph, or Clara onto expressive.
 */
export function coerceNarratorRecommendation(
  raw: unknown
): NarratorRecommendation | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const kind = row.kind;
  if (
    kind !== "article" &&
    kind !== "biography" &&
    kind !== "history" &&
    kind !== "nonfiction" &&
    kind !== "novel"
  ) {
    return null;
  }
  let catalogVoiceId = typeof row.catalogVoiceId === "string" ? row.catalogVoiceId : "";
  let delivery: StockDeliveryMode =
    row.delivery === "expressive" ? "expressive" : "standard";
  let novelKind =
    typeof row.novelKind === "string"
      ? row.novelKind.replace(/\s+/g, " ").trim().slice(0, 60)
      : "";

  if (kind === "article" || kind === "biography" || kind === "nonfiction") {
    catalogVoiceId = "standard";
    delivery = "standard";
    novelKind = "";
  } else if (kind === "history") {
    catalogVoiceId = "randolph";
    delivery = "standard";
    novelKind = "";
  } else if (!isStockId(catalogVoiceId)) {
    return null;
  } else if (catalogVoiceId === "clara") {
    delivery = "standard";
  }

  if (!isStockId(catalogVoiceId)) return null;
  return {
    catalogVoiceId,
    delivery,
    kind,
    novelKind: kind === "novel" && novelKind ? novelKind : null,
    kindLabel: kindLabelFor(kind, kind === "novel" ? novelKind : null),
  };
}

export type ListenChunkNote = {
  kind: NarratorKind | null;
  novelKind: string | null;
  tone: string;
  pov: string;
  dialogue: "low" | "medium" | "high" | null;
};

function majority<T extends string>(values: T[]): T | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [value, count] of counts) {
    if (count > n) {
      best = value;
      n = count;
    }
  }
  return best;
}

/**
 * One suggestion from the per-chunk notes. No second pass over the book.
 * Product rules still force nonfiction onto Andrew and history onto Randolph.
 */
export function narratorFromChunkNotes(
  notes: ListenChunkNote[]
): NarratorRecommendation | null {
  const kinds = notes.flatMap((note) => (note.kind ? [note.kind] : []));
  const kind = majority(kinds);
  if (!kind) return null;
  const novelNotes = notes.filter((note) => note.kind === "novel" && note.novelKind);
  const novelKind = (majority(novelNotes.map((note) => note.novelKind!)) || "")
    .toLowerCase();
  const dialogue = majority(
    notes.flatMap((note) => (note.dialogue ? [note.dialogue] : []))
  );
  const tone = notes.map((note) => note.tone.toLowerCase()).join(" ");
  let catalogVoiceId: NarratorCatalogVoiceId = "standard";
  let delivery: StockDeliveryMode = "standard";
  if (kind === "novel") {
    if (/romance|cozy|contemporary/.test(novelKind)) {
      catalogVoiceId = "michelle";
      delivery = "expressive";
    } else if (/historical|gothic/.test(novelKind) || /gothic|dramatic/.test(tone)) {
      catalogVoiceId = "randolph";
      delivery = /gothic|dramatic/.test(`${novelKind} ${tone}`) ? "expressive" : "standard";
    } else if (/thriller|horror|fantasy/.test(novelKind) || dialogue === "high") {
      catalogVoiceId = "standard";
      delivery = "expressive";
    }
  }
  return coerceNarratorRecommendation({
    kind,
    novelKind: kind === "novel" ? novelKind || null : null,
    catalogVoiceId,
    delivery,
  });
}

/** True when this row is the suggestion the picker should mark. */
export function narratorMarksVoice(
  rec: NarratorRecommendation,
  voiceId: string,
  mode: StockDeliveryMode,
  opts?: { expressiveAvailable?: boolean }
): boolean {
  if (rec.catalogVoiceId !== voiceId) return false;
  const expressive =
    rec.delivery === "expressive" && opts?.expressiveAvailable === true;
  return expressive ? mode === "expressive" : mode === "standard";
}

/** "Andrew (recommended)" or "Andrew (Expressive, recommended)". */
export function withNarratorRecommendation(
  label: string,
  recommended: boolean
): string {
  if (!recommended) return label;
  if (label.endsWith(")")) return `${label.slice(0, -1)}, recommended)`;
  return `${label} (recommended)`;
}
