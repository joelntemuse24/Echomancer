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
 * Content-Disposition), not a redirect: Chrome, Edge, and Firefox dropped the
 * download across a 307 (PR #92).
 *
 * A finished book passes `job.download_url`: a presigned R2 link that answers
 * `Content-Disposition: attachment` itself. It is cross-origin, so browsers
 * ignore the `download` attribute but honour that header and save the file.
 * It is a direct link, not a redirect, and the bytes skip Vercel entirely.
 * In-progress books still use `/api/jobs/<id>/download`.
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
 * Milliseconds left on a SigV4 GET, from `X-Amz-Date` + `X-Amz-Expires`.
 * Null when the URL is not that shape (the same-origin download route).
 */
export function presignedUrlRemainingMs(url: string, now = Date.now()): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const date = parsed.searchParams.get("X-Amz-Date");
  const expires = Number(parsed.searchParams.get("X-Amz-Expires"));
  if (!date || !Number.isFinite(expires) || expires <= 0) return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!match) return null;
  const signed = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
  if (!Number.isFinite(signed)) return null;
  return signed + expires * 1000 - now;
}

/**
 * A finished book downloads from R2. The click cannot wait on a refetch
 * (iOS drops the user gesture), so an expired signature is refused rather
 * than sent through `/api/jobs/[id]/download`, which dies at the function
 * time limit on a multi-GB file. Null means the caller should refresh the
 * job and ask for another tap. No direct URL keeps the same-origin route
 * for a book that is still generating.
 */
export function audiobookDownloadUrl(
  direct: string | null | undefined,
  fallback: string,
  now = Date.now()
): string | null {
  if (!direct) return fallback;
  const left = presignedUrlRemainingMs(direct, now);
  if (left != null && left < 60_000) return null;
  return direct;
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
