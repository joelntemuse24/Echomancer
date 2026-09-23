/**
 * Product rules for a stock narrator suggestion.
 * Safe in the voice picker: no network, no storage, no book text.
 */

import { stockDeliveryLabel, type StockDeliveryMode } from "@/lib/tts/stock-delivery";

const STOCK_IDS = ["standard", "michelle", "clara", "randolph"] as const;
export type NarratorCatalogVoiceId = (typeof STOCK_IDS)[number];

const DISPLAY_NAME: Record<NarratorCatalogVoiceId, string> = {
  standard: "Andrew",
  michelle: "Michelle",
  clara: "Clara",
  randolph: "Randolph",
};

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

export function narratorSuggestionLine(
  rec: NarratorRecommendation,
  opts?: { expressiveAvailable?: boolean }
): string {
  const expressive =
    rec.delivery === "expressive" && opts?.expressiveAvailable === true;
  const name = stockDeliveryLabel(
    DISPLAY_NAME[rec.catalogVoiceId],
    expressive ? "expressive" : "standard"
  );
  return `${rec.kindLabel}. ${name}. You can choose another.`;
}
