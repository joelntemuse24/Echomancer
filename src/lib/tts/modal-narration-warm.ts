import type { CloneProviderChoice } from "@/lib/tts/providers/modal-clone-guard";

/**
 * A tick must not start a side `::cover` before the outline exists.
 *
 * The book's `POST /synthesize_batch` is the container it will use. A cover
 * beside that POST restores a second H100 that never receives the request.
 * Concat, a fish pin, and a book with nothing left to speak stay dark too.
 */
export function shouldPrewarmBeforeOutline(input: {
  modalVoice: boolean;
  clonePin: CloneProviderChoice | null;
  totalSections: number;
  claimableCount: number;
}): boolean {
  void input;
  return false;
}

/**
 * A tick that already knows it will synthesize must not start a side cover.
 * The uncached rows go out on `/synthesize_batch`, and that call is the GPU.
 */
export function shouldPrewarmModalNarration(input: {
  modalVoice: boolean;
  clonePin: CloneProviderChoice | null;
  uncachedRenderCount: number;
}): boolean {
  void input;
  return false;
}
