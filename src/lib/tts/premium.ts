/**
 * Soft premium gate for MOSS custom voice cloning.
 * Full Stripe/auth comes later — this is flag + optional allowlist.
 */

export function isPremiumCloneEnabled(opts?: {
  ip?: string | null;
  userId?: string | null;
}): boolean {
  if (process.env.PREMIUM_CLONE_ENABLED === "true") return true;

  const allowlist = (process.env.PREMIUM_CLONE_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowlist.length === 0) return false;

  const candidates = [opts?.ip, opts?.userId].filter(Boolean) as string[];
  return candidates.some((c) => allowlist.includes(c));
}

export function premiumCloneDeniedMessage(): string {
  return "Custom voice cloning is a premium feature. Use a stock narrator, or enable PREMIUM_CLONE_ENABLED.";
}
