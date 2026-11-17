/**
 * A clone's display name. A leading personal name is kept ("Henry Kissinger
 * announces…" → "Henry Kissinger"). Otherwise the title or file name, shortened.
 * Never "YouTube clip" or "My voice".
 */

const GENERIC =
  /^(youtube(\s+clip)?|youtube\s+video|my\s+voice|voice|audio|recording|untitled|sample)$/i;

function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max).replace(/\s+\S*$/, "").trim();
  return cut.length >= 8 ? cut : value.slice(0, max).trim();
}

export function cloneNameFromSource(raw: string | null | undefined): string {
  let title = (raw ?? "").replace(/\s+/g, " ").trim();
  title = title.replace(/\s*[-|–—]\s*youtube$/i, "");
  title = title.replace(/\.(mp3|wav|m4a|ogg|webm|opus|mpeg|mp4)$/i, "");
  title = title.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title || GENERIC.test(title)) return "";

  const name: string[] = [];
  for (const word of title.split(" ")) {
    if (name.length >= 3) break;
    const bare = word.replace(/[.,:;]+$/g, "");
    if (/^[A-Z][a-zA-ZÀ-ɏ'’.-]{1,}$/.test(bare)) name.push(bare);
    else break;
  }
  if (name.length >= 2) return name.join(" ");
  const shortened = shorten(title, 48);
  return GENERIC.test(shortened) ? "" : shortened;
}

/** Last resort when a source has no usable words. */
export function cloneNameOrFallback(
  raw: string | null | undefined,
  fallback = "Voice"
): string {
  return cloneNameFromSource(raw) || fallback;
}

/**
 * Prefill for the upload name field. The file's own words stay, including a
 * stem that would otherwise collapse to "Voice", so the person can edit it.
 */
export function cloneNameDraftFromFile(filename: string | null | undefined): string {
  const named = cloneNameFromSource(filename);
  if (named) return named;
  const stem = (filename ?? "")
    .replace(/\.(mp3|wav|m4a|ogg|webm|opus|mpeg|mp4)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return shorten(stem, 80);
}

/** The name that is saved. An edited draft is kept even when the words are generic. */
export function cloneTitleFromDraft(draft: string | null | undefined): string {
  const trimmed = (draft ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "Voice";
  return shorten(trimmed, 80);
}
