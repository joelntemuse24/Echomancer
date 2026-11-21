/**
 * Destinations the header actually moves between.
 *
 * Home is the create flow and the plus points there. The header plus is an
 * icon only (its name is the aria-label), and it is absent on `/` itself:
 * the home page already opens with a book upload, so a second "new book"
 * control next to it would be the same action twice. Library and Voices are
 * the other two stops. Full prefetch is required: these routes read cookies
 * nowhere in their shell, but a default Link prefetch still stops at
 * `loading.tsx` for anything Next treats as dynamic.
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

/**
 * Whether the dashboard chrome shows its plus.
 *
 * Home is the upload page: its own composer is the new-book control, so the
 * plus would duplicate it. Every other interior route keeps the plus,
 * including Library, Voices, and a book's player.
 */
export function showHeaderNewBook(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname !== "/";
}
