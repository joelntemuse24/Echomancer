/**
 * Destinations the header actually moves between.
 *
 * Home is the create flow. The circled plus points here and is rendered
 * only by the dashboard chrome, so it does not appear on `/` itself.
 * Library and Voices are the other two stops. Full prefetch is required:
 * these routes read cookies nowhere in their shell, but a default Link
 * prefetch still stops at `loading.tsx` for anything Next treats as dynamic.
 */

export const CREATE_HREF = "/";
export const VOICES_HREF = "/dashboard/voice";
export const LIBRARY_HREF = "/dashboard/queue";

export const DASHBOARD_NAV = [
  { href: VOICES_HREF, label: "voices" },
  { href: LIBRARY_HREF, label: "library" },
] as const;

/** Load the route's RSC and JS, not only the loading boundary. */
export const PREFETCH_SCREEN = true;
