/**
 * Cheap preload for clone previews that are already on screen.
 *
 * Metadata asks the browser for the start of the file, not a full download
 * of every card. One selected clip may preload fully on a fast link. Save-data
 * and 2G preload nothing.
 */

export const CLONE_PREVIEW_PRELOAD_CAP = 8;

export type ClonePreviewPreloadMode = {
  list: "none" | "metadata";
  selected: "none" | "metadata" | "auto";
};

type NetworkHint = {
  saveData?: boolean;
  effectiveType?: string;
} | null;

export function clonePreviewPreloadMode(
  connection?: NetworkHint
): ClonePreviewPreloadMode {
  // No network hint (Safari, and this module under Node) stays at metadata.
  // A full preload of every card is what we are avoiding on mobile data.
  if (!connection) return { list: "metadata", selected: "metadata" };
  if (connection.saveData) return { list: "none", selected: "none" };
  const type = connection.effectiveType;
  if (type === "slow-2g" || type === "2g") return { list: "none", selected: "none" };
  if (type === "4g") return { list: "metadata", selected: "auto" };
  return { list: "metadata", selected: "metadata" };
}

export function currentClonePreviewPreloadMode(): ClonePreviewPreloadMode {
  if (typeof navigator === "undefined") return clonePreviewPreloadMode(null);
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  return clonePreviewPreloadMode(connection ?? null);
}

export function planClonePreviewPreload(input: {
  voices: readonly { id: string; previewUrl?: string | null }[];
  selectedId?: string | null;
  mode: ClonePreviewPreloadMode;
}): { url: string; preload: "metadata" | "auto" }[] {
  if (input.mode.list === "none" && input.mode.selected === "none") return [];
  const out: { url: string; preload: "metadata" | "auto" }[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined, preload: "metadata" | "auto") => {
    const trimmed = url?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ url: trimmed, preload });
  };

  if (input.mode.selected !== "none" && input.selectedId) {
    const selected = input.voices.find((voice) => voice.id === input.selectedId);
    if (selected?.id.startsWith("clone:")) {
      push(selected.previewUrl, input.mode.selected === "auto" ? "auto" : "metadata");
    }
  }
  if (input.mode.list === "none") return out;
  for (const voice of input.voices) {
    if (out.length >= CLONE_PREVIEW_PRELOAD_CAP) break;
    if (!voice.id.startsWith("clone:") || !voice.previewUrl) continue;
    push(voice.previewUrl, "metadata");
  }
  return out;
}
