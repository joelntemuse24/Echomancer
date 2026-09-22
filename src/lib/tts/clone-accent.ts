/**
 * Client-safe accent labels for user Fish clones.
 * Stored on `cloned_voices.accent`. This is a catalog label (Shauna · British),
 * not a Fish training parameter.
 */

export const CLONE_ACCENTS = ["american", "british", "australian", "irish"] as const;

export type CloneAccent = (typeof CLONE_ACCENTS)[number];

export const DEFAULT_CLONE_ACCENT: CloneAccent = "american";

export const CLONE_ACCENT_LABELS: Record<CloneAccent, string> = {
  american: "American",
  british: "British",
  australian: "Australian",
  irish: "Irish",
};

export const CLONE_ACCENT_LOCALE: Record<CloneAccent, string> = {
  american: "en-US",
  british: "en-GB",
  australian: "en-AU",
  irish: "en-IE",
};

export function isCloneAccent(value: string | null | undefined): value is CloneAccent {
  return (CLONE_ACCENTS as readonly string[]).includes((value || "").trim().toLowerCase());
}

/** Unknown or missing values stay American — the historical clone default. */
export function parseCloneAccent(value: string | null | undefined): CloneAccent {
  const normalized = (value || "").trim().toLowerCase();
  return isCloneAccent(normalized) ? normalized : DEFAULT_CLONE_ACCENT;
}
