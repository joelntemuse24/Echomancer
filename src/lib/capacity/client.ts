/**
 * Browser side of a shared warm. The request carries no provider secret.
 * Navigation does not wait on it.
 */

import { readStockVoicePick } from "@/lib/stock-voice-pick";

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
