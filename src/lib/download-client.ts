/** Trigger a reliable browser download from a URL (avoids truncated streams). */
export async function downloadFromUrl(
  url: string,
  filename: string
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      (data && typeof data.error === "string" && data.error) ||
        `Download failed (${res.status})`
    );
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function audiobookFilename(title: string | null | undefined): string {
  const base = (title || "audiobook").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return `${base || "audiobook"}.mp3`;
}
