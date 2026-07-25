/**
 * Soft premium gate for HD voice models (e.g. Minimax).
 * Full Stripe/auth comes later — this is flag + optional allowlist.
 */

export function isPremiumHdEnabled(opts?: {
  ip?: string | null;
  userId?: string | null;
}): boolean {
  if (process.env.PREMIUM_HD_ENABLED === "true") return true;

  const allowlist = (process.env.PREMIUM_HD_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowlist.length === 0) return false;

  const candidates = [opts?.ip, opts?.userId].filter(Boolean) as string[];
  return candidates.some((c) => allowlist.includes(c));
}

export function premiumHdDeniedMessage(): string {
  return "HD voices are a premium feature. Enable PREMIUM_HD_ENABLED or use a standard narrator.";
}

/** Check if a catalog voice is a premium HD model (Minimax etc.) */
export function isHdVoice(voice: { model: string; tags?: string[] }): boolean {
  const m = voice.model.toLowerCase();
  return (
    m.includes("minimax") ||
    m.includes("speech-02") ||
    m.includes("speech-01") ||
    (voice.tags?.some((t) => t.toLowerCase() === "hd") ?? false)
  );
}
