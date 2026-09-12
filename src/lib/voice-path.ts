import { isFishCloneVoice } from "@/lib/tts/fish-clone";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";

/** First voice-step choice after intake. Not a catalog. */
export type VoicePath = "standard" | "clone";

export function parseVoicePath(
  raw: string | null | undefined
): VoicePath | null {
  if (raw === "standard" || raw === "clone") return raw;
  return null;
}

type PathVoice = {
  id: string;
  provider?: string | null;
  providerVoiceId?: string | null;
  tags?: string[] | null;
};

/** Standard = slim stock in picker order. Clone = user clones only (not Clara). */
export function voicesForPath<T extends PathVoice>(
  voices: T[],
  path: VoicePath
): T[] {
  if (path === "standard") {
    const byId = new Map(voices.map((voice) => [voice.id, voice]));
    return SLIM_STOCK_VOICE_IDS.map((id) => byId.get(id)).filter(
      (voice): voice is T => Boolean(voice)
    );
  }
  return voices.filter((voice) => isFishCloneVoice(voice));
}

export function withVoicePathParam(
  params: string | URLSearchParams,
  path: VoicePath | null
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (path) next.set("path", path);
  else next.delete("path");
  return next;
}
