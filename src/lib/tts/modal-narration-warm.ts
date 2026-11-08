import type { CloneProviderChoice } from "@/lib/tts/providers/modal-clone-guard";

/**
 * Whether this tick may start a GPU snapshot restore before it has an outline.
 *
 * A brand-new book has no sections yet, so the restore overlaps packing.
 * A book that already has an outline waits until we know a section still
 * needs S2: concat, saved raw, and a cache hit must not start a container.
 * A fish pin never does, including a book that fell back off the GPU.
 */
export function shouldPrewarmBeforeOutline(input: {
  modalVoice: boolean;
  clonePin: CloneProviderChoice | null;
  totalSections: number;
  claimableCount: number;
}): boolean {
  if (!input.modalVoice) return false;
  if (input.clonePin === "fish") return false;
  if (input.totalSections > 0 && input.claimableCount === 0) return false;
  if (input.totalSections > 0 && input.claimableCount > 0) return false;
  return true;
}

/**
 * Whether a tick that already classified its sections should start a restore.
 * Only an uncached S2 render does. Cache hits, a fish pin, and an empty
 * claim set do not.
 */
export function shouldPrewarmModalNarration(input: {
  modalVoice: boolean;
  clonePin: CloneProviderChoice | null;
  uncachedRenderCount: number;
}): boolean {
  if (!input.modalVoice) return false;
  if (input.clonePin !== "modal") return false;
  return input.uncachedRenderCount > 0;
}
