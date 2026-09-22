/**
 * What the voice-step chevron does next.
 *
 * A pending clone sample is its own step. It must never fall through to the
 * auto-selected existing clone (the first saved voice, e.g. Yona).
 * Fail blocks; warn is allowed through. With a book in the URL, the same
 * press clones, selects the new voice, then starts take-home.
 */

export type VoiceContinuePath = "standard" | "clone" | null;

export type VoiceContinueQuality = "pass" | "warn" | "fail" | null;

export type VoiceContinueDecision =
  | { type: "clone-and-start" }
  | { type: "clone-only" }
  | { type: "start-selected" }
  | {
      type: "blocked";
      reason: "busy" | "quality-fail" | "quality-checking" | "nothing";
    };

export function resolveVoiceContinue(input: {
  path: VoiceContinuePath;
  hasPendingSample: boolean;
  qualityVerdict: VoiceContinueQuality;
  qualityChecking: boolean;
  busy: boolean;
  hasSelectedVoice: boolean;
  hasBook: boolean;
}): VoiceContinueDecision {
  if (input.busy) return { type: "blocked", reason: "busy" };

  if (input.path === "clone" && input.hasPendingSample) {
    if (input.qualityChecking) {
      return { type: "blocked", reason: "quality-checking" };
    }
    if (input.qualityVerdict === "fail") {
      return { type: "blocked", reason: "quality-fail" };
    }
    return input.hasBook
      ? { type: "clone-and-start" }
      : { type: "clone-only" };
  }

  if (input.hasSelectedVoice) return { type: "start-selected" };
  return { type: "blocked", reason: "nothing" };
}
