/**
 * The player route is `/dashboard/player/:id`. Reading the id from the
 * pathname lets the page paint without `use(params)`, which suspends into
 * the nearest fallback — a spinner — until the promise resolves.
 */
export function playerIdFromPathname(pathname: string | null | undefined): string {
  if (!pathname) return "";
  const parts = pathname.split("/").filter(Boolean);
  const at = parts.indexOf("player");
  if (at < 0 || parts.length !== at + 2) return "";
  const raw = parts[at + 1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
