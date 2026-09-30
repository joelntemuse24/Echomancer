/**
 * Product rules for a stock narrator suggestion.
 * Safe in the voice picker: no network, no storage, no book text.
 */

const STOCK_IDS = ["standard", "ava", "libby", "randolph"] as const;
export type NarratorCatalogVoiceId = (typeof STOCK_IDS)[number];

export type NarratorKind =
  | "article"
  | "biography"
  | "history"
  | "nonfiction"
  | "novel";

export type NarratorRecommendation = {
  catalogVoiceId: NarratorCatalogVoiceId;
  delivery: "standard";
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
 * Enforce the product rules. The model may not move nonfiction off Andrew
 * or history off Randolph. A stored `expressive` delivery becomes standard.
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
  let novelKind =
    typeof row.novelKind === "string"
      ? row.novelKind.replace(/\s+/g, " ").trim().slice(0, 60)
      : "";

  if (kind === "article" || kind === "biography" || kind === "nonfiction") {
    catalogVoiceId = "standard";
    novelKind = "";
  } else if (kind === "history") {
    catalogVoiceId = "randolph";
    novelKind = "";
  } else if (catalogVoiceId === "michelle") {
    catalogVoiceId = "ava";
  } else if (catalogVoiceId === "clara") {
    catalogVoiceId = "libby";
  } else if (!isStockId(catalogVoiceId)) {
    return null;
  }

  if (!isStockId(catalogVoiceId)) return null;
  return {
    catalogVoiceId,
    delivery: "standard",
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
  if (kind === "novel") {
    if (/romance|cozy|contemporary/.test(novelKind)) {
      catalogVoiceId = "ava";
    } else if (/historical|gothic/.test(novelKind) || /gothic|dramatic/.test(tone)) {
      catalogVoiceId = "randolph";
    } else if (/thriller|horror|fantasy/.test(novelKind) || dialogue === "high") {
      catalogVoiceId = "standard";
    }
  }
  return coerceNarratorRecommendation({
    kind,
    novelKind: kind === "novel" ? novelKind || null : null,
    catalogVoiceId,
    delivery: "standard",
  });
}

/** True when this row is the suggestion the picker should mark. */
export function narratorMarksVoice(
  rec: NarratorRecommendation,
  voiceId: string
): boolean {
  return rec.catalogVoiceId === voiceId;
}

/** "Andrew (recommended)". */
export function withNarratorRecommendation(
  label: string,
  recommended: boolean
): string {
  if (!recommended) return label;
  if (label.endsWith(")")) return `${label.slice(0, -1)}, recommended)`;
  return `${label} (recommended)`;
}
