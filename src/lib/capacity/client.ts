/**
 * Browser side of a shared warm. The request carries no provider secret.
 * Navigation does not wait on it.
 */

import { readStockVoicePick } from "@/lib/stock-voice-pick";
import { isKokoroCpuVoiceId } from "@/lib/tts/kokoro-voice-ids";

/**
 * What a picker selection may warm.
 *
 * Kokoro narrators warm their CPU app. A clone does not: Play is a stored
 * MP3, and posting `/api/capacity/warm` for `s2` starts a GPU the preview
 * never uses.
 */
export function capacityWarmForVoiceSelect(
  voiceId: string
): { voiceId: string; reason: "voice" } | null {
  if (!voiceId || voiceId.startsWith("clone:")) return null;
  if (!isKokoroCpuVoiceId(voiceId)) return null;
  return { voiceId, reason: "voice" };
}

export function requestCapacityWarm(input: {
  voiceId?: string | null;
  reason: "create" | "voice";
}): void {
  void fetch("/api/capacity/warm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      voiceId: input.voiceId ?? null,
      reason: input.reason,
    }),
    keepalive: true,
  }).catch(() => {});
}

/** Warm the shared pools for the saved voice. Navigation does not wait on it. */
export function prepareNewAudiobook(): void {
  const pick = readStockVoicePick();
  requestCapacityWarm({
    voiceId: pick?.catalogVoiceId ?? null,
    reason: "create",
  });
}
