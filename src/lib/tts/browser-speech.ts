/**
 * Browser Live Listen for Edge stock voices (Andrew / Ava / Libby).
 *
 * Only matches the named neural / Edge online-natural voice — never a random
 * system voice. Callers must fall back to server Edge TTS when this returns null.
 * Randolph is Google Cloud TTS and does not use this path.
 */

import {
  ANDREW_NEURAL_VOICE_ID,
  type EdgeBrowserTarget,
  edgeBrowserTarget,
} from "@/lib/tts/standard-voice";

export type BrowserSpeechVoice = {
  name: string;
  voiceURI: string;
  lang: string;
};

export function speechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function localeMatches(hay: string, locale: string): boolean {
  const loc = locale.toLowerCase();
  if (hay.includes(loc) || hay.includes(loc.replace("-", "_"))) return true;
  if (loc === "en-us") {
    return hay.includes("united states") || hay.includes("american");
  }
  if (loc === "en-gb") {
    return (
      hay.includes("united kingdom") ||
      hay.includes("great britain") ||
      hay.includes("british") ||
      hay.includes("england")
    );
  }
  return false;
}

/** Score > 0 only for the requested Edge neural / online-natural voice. */
export function scoreEdgeNeuralVoice(
  voice: BrowserSpeechVoice,
  target: EdgeBrowserTarget
): number {
  const hay = `${voice.name} ${voice.voiceURI} ${voice.lang}`.toLowerCase();
  const short = target.shortName.toLowerCase();
  if (!hay.includes(short)) return 0;

  const compact = hay.replace(/[\s_-]+/g, "");
  const neuralCompact = target.neuralId.toLowerCase().replace(/[\s_-]+/g, "");
  if (compact.includes(neuralCompact) || compact.includes(`${short}neural`)) {
    return 100;
  }

  const neuralish =
    hay.includes("neural") || hay.includes("natural") || hay.includes("online");
  if (!neuralish) return 0;

  if (localeMatches(hay, target.locale)) return 80;
  return 60;
}

export function matchEdgeNeuralVoice<T extends BrowserSpeechVoice>(
  voices: T[],
  target: EdgeBrowserTarget
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const voice of voices) {
    const score = scoreEdgeNeuralVoice(voice, target);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

const ANDREW_TARGET: EdgeBrowserTarget = {
  shortName: "Andrew",
  locale: "en-US",
  neuralId: ANDREW_NEURAL_VOICE_ID,
};

/** Score > 0 only for Andrew Neural / Edge online-natural Andrew. */
export function scoreAndrewNeuralVoice(voice: BrowserSpeechVoice): number {
  return scoreEdgeNeuralVoice(voice, ANDREW_TARGET);
}

export function matchAndrewNeuralVoice<T extends BrowserSpeechVoice>(
  voices: T[]
): T | null {
  return matchEdgeNeuralVoice(voices, ANDREW_TARGET);
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

export async function speakPreviewWithEdgeNeural(
  text: string,
  target: EdgeBrowserTarget,
  opts?: { onEnd?: () => void; onError?: (message: string) => void }
): Promise<"played" | "unavailable"> {
  if (!speechSynthesisAvailable()) return "unavailable";
  const voices = await waitForSpeechVoices();
  const voice = matchEdgeNeuralVoice(voices, target);
  if (!voice) return "unavailable";

  cancelBrowserSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang || target.locale;
  utterance.rate = 1;
  utterance.onend = () => opts?.onEnd?.();
  utterance.onerror = (event) => {
    opts?.onError?.(event.error || "speech synthesis failed");
  };
  window.speechSynthesis.speak(utterance);
  return "played";
}

export async function speakPreviewWithAndrew(
  text: string,
  opts?: { onEnd?: () => void; onError?: (message: string) => void }
): Promise<"played" | "unavailable"> {
  return speakPreviewWithEdgeNeural(text, ANDREW_TARGET, opts);
}

/** Try browser TTS for an Edge stock voice; Randolph / clones skip this. */
export async function speakPreviewForStockVoice(
  text: string,
  voice: {
    id?: string | null;
    provider?: string | null;
    providerVoiceId?: string | null;
    model?: string | null;
  },
  opts?: { onEnd?: () => void; onError?: (message: string) => void }
): Promise<"played" | "unavailable"> {
  const target = edgeBrowserTarget(voice);
  if (!target) return "unavailable";
  return speakPreviewWithEdgeNeural(text, target, opts);
}

/** Exported for tests / docs — default stock browser target. */
export const BROWSER_STANDARD_VOICE_HINT = ANDREW_NEURAL_VOICE_ID;
