/**
 * Hand the audiobook to the browser's own download / share UI.
 *
 * Fetching the file into a blob, then clicking a blob: URL, stalls on a phone:
 * `blob()` waits for the whole book (often tens of MB) so the "Preparing…"
 * toast never advances, iOS Safari ignores `<a download>` on blob URLs, and
 * revoking the object URL in the same turn cancels the save before it starts.
 * A same-origin link lets the browser save the attachment. The click has to
 * happen inside the tap — no await before it. Desktop must stay in this
 * window (`<a download>`, no `_blank`). iOS opens a new tab so Share → Save
 * to Files still works. The URL itself has to be the file (200 +
 * Content-Disposition), not a redirect: Chrome, Edge, and Firefox drop the
 * download across a 307.
 */

export interface DownloadNavigator {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function audiobookFilename(title: string | null | undefined): string {
  const base = (title || "audiobook").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return `${base || "audiobook"}.mp3`;
}

/** iPhone, iPod, and iPadOS (which reports itself as a Mac). */
export function isIosDownload(nav?: DownloadNavigator | null): boolean {
  const source =
    nav ??
    (typeof navigator === "undefined"
      ? null
      : {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          maxTouchPoints: navigator.maxTouchPoints,
        });
  if (!source) return false;
  const ua = source.userAgent ?? "";
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  return source.platform === "MacIntel" && (source.maxTouchPoints ?? 0) > 1;
}

/**
 * Start the download immediately. Returns nothing and does not wait on the
 * body — the browser owns the transfer after the click.
 */
export function startAudiobookDownload(url: string, filename: string): void {
  if (typeof document === "undefined") {
    throw new Error("Download failed");
  }
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  if (isIosDownload()) anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  // Removing the node in the same turn cancels the download in Chromium.
  setTimeout(() => anchor.remove(), 0);
}
