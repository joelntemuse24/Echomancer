/**
 * Customer-facing Standard vs Expressive choice.
 * Safe to import from the voice picker: no env and no provider ids.
 *
 * Expressive is the Fish twin of a Standard slot (Andrew, Michelle, Randolph).
 * Clara and user clones are not part of this choice.
 */

export type StockDeliveryMode = "standard" | "expressive";

/** What the voices API tells the picker. Never includes a Fish reference id. */
export type ExpressiveOffer = {
  /** A 32-hex Fish reference is wired for this slot. */
  configured: boolean;
  /** Reference wired and the quality gate is open — selectable and previewable. */
  available: boolean;
};

export function parseStockDeliveryMode(raw: unknown): StockDeliveryMode {
  return raw === "expressive" ? "expressive" : "standard";
}

/**
 * Show the quiet Expressive control once a twin reference exists.
 * No reference: hide it. The picker stays the four stock names.
 */
export function showExpressiveChoice(
  offer: ExpressiveOffer | null | undefined
): boolean {
  return Boolean(offer?.configured);
}

export function expressiveChoiceEnabled(
  offer: ExpressiveOffer | null | undefined
): boolean {
  return Boolean(offer?.configured && offer.available);
}

/** "Standard" or "Standard (Expressive)". Strips a repeated suffix. */
export function stockDeliveryLabel(
  displayName: string,
  mode: StockDeliveryMode
): string {
  const base = displayName.replace(/\s*\(Expressive\)\s*$/i, "").trim();
  const name = base || displayName.trim();
  if (mode === "expressive") return `${name} (Expressive)`;
  return name;
}
