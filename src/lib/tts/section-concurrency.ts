/**
 * Edge and Google whole-book sections do not use the Fish account, so they
 * do not share the Fish fan-out (4, or 5 when nothing live is in flight).
 * Fish and clones stay on {@link takehomeFanoutCap}.
 */

export const EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT = 6;
export const EDGE_GOOGLE_SECTION_CONCURRENCY_MAX = 8;

export function isEdgeOrGoogleProvider(provider?: string | null): boolean {
  const id = provider?.toLowerCase() || "";
  return id === "edge" || id === "google";
}

/** Parallel sections for one Edge or Google book. Clamped to 1–8. Default 6. */
export function edgeGoogleSectionConcurrency(): number {
  const raw = Number(process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY);
  const chosen =
    Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT;
  return Math.max(
    1,
    Math.min(EDGE_GOOGLE_SECTION_CONCURRENCY_MAX, chosen)
  );
}
