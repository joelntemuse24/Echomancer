/**
 * Browser Live Listen for Standard (Andrew Neural).
 *
 * Only matches Andrew Neural / Edge online-natural Andrew — never a random
 * system voice. Callers must fall back to server Edge TTS when this returns null.
 */

import { ANDREW_NEURAL_VOICE_ID } from "@/lib/tts/standard-voice";

export type BrowserSpeechVoice = {
  name: string;
  voiceURI: string;
  lang: string;
};

export function speechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Score > 0 only for Andrew Neural / Edge online-natural Andrew. */
export function scoreAndrewNeuralVoice(voice: BrowserSpeechVoice): number {
  const hay = `${voice.name} ${voice.voiceURI} ${voice.lang}`.toLowerCase();
  if (!hay.includes("andrew")) return 0;

  const compact = hay.replace(/[\s_-]+/g, "");
  if (
    compact.includes("en-us-andrewneural") ||
    compact.includes("enusandrewneural") ||
    compact.includes("andrewneural")
  ) {
    return 100;
  }

  const neuralish =
    hay.includes("neural") || hay.includes("natural") || hay.includes("online");
  if (!neuralish) return 0;

  if (hay.includes("en-us") || hay.includes("en_us") || hay.includes("united states")) {
    return 80;
  }
  return 60;
}

export function matchAndrewNeuralVoice<T extends BrowserSpeechVoice>(
  voices: T[]
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const voice of voices) {
    const score = scoreAndrewNeuralVoice(voice);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

export function listSpeechVoices(): SpeechSynthesisVoice[] {
  if (!speechSynthesisAvailable()) return [];
  return window.speechSynthesis.getVoices();
}

export async function waitForSpeechVoices(
  timeoutMs = 1500
): Promise<SpeechSynthesisVoice[]> {
  const existing = listSpeechVoices();
  if (existing.length > 0) return existing;
  if (!speechSynthesisAvailable()) return [];

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.speechSynthesis.removeEventListener("voiceschanged", finish);
      resolve(listSpeechVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", finish);
    window.setTimeout(finish, timeoutMs);
  });
}

export function cancelBrowserSpeech(): void {
  if (!speechSynthesisAvailable()) return;
  window.speechSynthesis.cancel();
}

export async function speakPreviewWithAndrew(
  text: string,
  opts?: { onEnd?: () => void; onError?: (message: string) => void }
): Promise<"played" | "unavailable"> {
  if (!speechSynthesisAvailable()) return "unavailable";
  const voices = await waitForSpeechVoices();
  const voice = matchAndrewNeuralVoice(voices);
  if (!voice) return "unavailable";

  cancelBrowserSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang || "en-US";
  utterance.rate = 1;
  utterance.onend = () => opts?.onEnd?.();
  utterance.onerror = (event) => {
    opts?.onError?.(event.error || "speech synthesis failed");
  };
  window.speechSynthesis.speak(utterance);
  return "played";
}

/** Exported for tests / docs — the only stock browser target. */
export const BROWSER_STANDARD_VOICE_HINT = ANDREW_NEURAL_VOICE_ID;
