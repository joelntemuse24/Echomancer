/**
 * Half-open key range for every object under `prefix`.
 *
 * `substr(path, 1, n) = prefix` cannot use an index, so a playback or
 * delete check walked `jobs` or `uploads`. `path >= prefix AND path < end`
 * is the same set and uses the path index. `prefix` includes its trailing
 * slash (`pdfs/<id>/`), and the end is that slash incremented, so a sibling
 * id (`pdfs/<id>-extra/`) stays outside the range.
 */
export function storagePrefixBounds(prefix: string): { start: string; end: string } {
  if (!prefix) throw new Error("empty storage prefix");
  const last = prefix.charCodeAt(prefix.length - 1);
  return {
    start: prefix,
    end: prefix.slice(0, -1) + String.fromCharCode(last + 1),
  };
}
