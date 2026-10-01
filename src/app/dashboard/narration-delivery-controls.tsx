"use client";

export type DeliveryPref = {
  pauseStyle: "auto" | "sparse" | "normal";
  join: "auto" | "80" | "120" | "150";
  titles: "auto" | "on" | "off";
  /** Legacy localStorage field. The Seminar / Plain control is gone. */
  tone: "auto" | "on" | "off";
};

export const DEFAULT_DELIVERY_PREF: DeliveryPref = {
  pauseStyle: "auto",
  join: "auto",
  titles: "auto",
  tone: "auto",
};

export const DELIVERY_PREF_KEY = "echomancer:delivery-settings";

export function loadDeliveryPref(): DeliveryPref {
  try {
    const raw = localStorage.getItem(DELIVERY_PREF_KEY);
    if (!raw) return DEFAULT_DELIVERY_PREF;
    const parsed = JSON.parse(raw) as Partial<DeliveryPref>;
    return {
      pauseStyle:
        parsed.pauseStyle === "sparse" || parsed.pauseStyle === "normal"
          ? parsed.pauseStyle
          : "auto",
      join:
        parsed.join === "80" || parsed.join === "120" || parsed.join === "150"
          ? parsed.join
          : "auto",
      titles: parsed.titles === "on" || parsed.titles === "off" ? parsed.titles : "auto",
      tone: parsed.tone === "on" || parsed.tone === "off" ? parsed.tone : "auto",
    };
  } catch {
    return DEFAULT_DELIVERY_PREF;
  }
}

export function deliveryPrefToTtsOptions(pref: DeliveryPref) {
  return {
    pauseStyle: pref.pauseStyle,
    crossfadeMs: pref.join === "auto" ? "auto" : Number(pref.join),
    normalizeTitles:
      pref.titles === "auto" ? "auto" : pref.titles === "on",
    // Seminar / Plain is gone. Narration ignores this flag.
    deliveryPrefix: "auto" as const,
  };
}
