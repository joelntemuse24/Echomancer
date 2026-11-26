/**
 * One estimate for every Kokoro CPU call (Drew, Esther, George, Walter).
 *
 * Audio is about 0.055 s per character. A container-hour of that audio
 * costs about 5–11¢; $0.12 is a little above the measured range so a
 * long book still reserves less than the $20 per-book cap. Two thousand
 * sections of 350 characters is about $1.28. Two thousand sections at the
 * 2,000-character ceiling is about $7.33.
 */

import { modalPlatformRefusal } from "@/lib/modal/workspace-disabled";

export const KOKORO_AUDIO_SECONDS_PER_CHAR = 0.055;
export const KOKORO_USD_PER_AUDIO_HOUR = 0.12;

export function kokoroRemoteEstimate(chars: number): {
  estCostUsd: number;
  estMs: number;
} {
  const n = Number.isFinite(chars) && chars > 0 ? chars : 0;
  const seconds = n * KOKORO_AUDIO_SECONDS_PER_CHAR;
  return {
    estCostUsd: (seconds / 3600) * KOKORO_USD_PER_AUDIO_HOUR,
    estMs: Math.round(seconds * 1000),
  };
}

/**
 * A non-OK Kokoro response whose body is a Modal workspace refusal.
 * The caller still reads the body for any other status.
 */
export async function refuseKokoroHttp(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.clone().text().catch(() => "");
  const refused = modalPlatformRefusal(res.status, body);
  if (refused) throw refused;
}
