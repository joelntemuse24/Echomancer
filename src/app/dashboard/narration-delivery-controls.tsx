"use client";

import { UX } from "@/lib/ux-copy";

export type DeliveryPref = {
  pauseStyle: "auto" | "sparse" | "normal";
  join: "auto" | "80" | "120" | "150";
  titles: "auto" | "on" | "off";
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

export function saveDeliveryPref(next: DeliveryPref) {
  try {
    localStorage.setItem(DELIVERY_PREF_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

export function deliveryPrefToTtsOptions(pref: DeliveryPref) {
  return {
    pauseStyle: pref.pauseStyle,
    crossfadeMs: pref.join === "auto" ? "auto" : Number(pref.join),
    normalizeTitles:
      pref.titles === "auto" ? "auto" : pref.titles === "on",
    deliveryPrefix: pref.tone === "auto" ? "auto" : pref.tone === "on",
  };
}

function Pill<T extends string>({
  value,
  current,
  label,
  onPick,
}: {
  value: T;
  current: T;
  label: string;
  onPick: (value: T) => void;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className={`px-2 py-0.5 rounded-sm text-[11px] transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

export function NarrationDeliveryControls({
  value,
  onChange,
}: {
  value: DeliveryPref;
  onChange: (next: DeliveryPref) => void;
}) {
  return (
    <div className="mb-8 p-4 rounded-sm border border-border/60 bg-accent/20 space-y-3">
      <p className="font-serif text-base">{UX.narrationDelivery}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {UX.pauseStyle}
          </span>
          <div className="flex flex-wrap gap-1">
            <Pill
              value="auto"
              current={value.pauseStyle}
              label={UX.pauseAuto}
              onPick={(pauseStyle) => onChange({ ...value, pauseStyle })}
            />
            <Pill
              value="sparse"
              current={value.pauseStyle}
              label={UX.pauseSparse}
              onPick={(pauseStyle) => onChange({ ...value, pauseStyle })}
            />
            <Pill
              value="normal"
              current={value.pauseStyle}
              label={UX.pauseNormal}
              onPick={(pauseStyle) => onChange({ ...value, pauseStyle })}
            />
          </div>
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {UX.joinStyle}
          </span>
          <div className="flex flex-wrap gap-1">
            <Pill
              value="auto"
              current={value.join}
              label={UX.joinAuto}
              onPick={(join) => onChange({ ...value, join })}
            />
            <Pill
              value="80"
              current={value.join}
              label={UX.joinShort}
              onPick={(join) => onChange({ ...value, join })}
            />
            <Pill
              value="120"
              current={value.join}
              label={UX.joinSoft}
              onPick={(join) => onChange({ ...value, join })}
            />
            <Pill
              value="150"
              current={value.join}
              label={UX.joinLong}
              onPick={(join) => onChange({ ...value, join })}
            />
          </div>
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {UX.titleCleanup}
          </span>
          <div className="flex flex-wrap gap-1">
            <Pill
              value="auto"
              current={value.titles}
              label={UX.titleAuto}
              onPick={(titles) => onChange({ ...value, titles })}
            />
            <Pill
              value="on"
              current={value.titles}
              label={UX.titleClean}
              onPick={(titles) => onChange({ ...value, titles })}
            />
            <Pill
              value="off"
              current={value.titles}
              label={UX.titleKeep}
              onPick={(titles) => onChange({ ...value, titles })}
            />
          </div>
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {UX.toneStyle}
          </span>
          <div className="flex flex-wrap gap-1">
            <Pill
              value="auto"
              current={value.tone}
              label={UX.toneAuto}
              onPick={(tone) => onChange({ ...value, tone })}
            />
            <Pill
              value="on"
              current={value.tone}
              label={UX.toneSeminar}
              onPick={(tone) => onChange({ ...value, tone })}
            />
            <Pill
              value="off"
              current={value.tone}
              label={UX.tonePlain}
              onPick={(tone) => onChange({ ...value, tone })}
            />
          </div>
        </label>
      </div>
    </div>
  );
}
