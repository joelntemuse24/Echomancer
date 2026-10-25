import type { SynthesizeInput } from "@/lib/tts/types";
import { sniffAudioContentType } from "@/lib/tts/pcm-wav";

export const OPENROUTER_CLONE_MODEL = "fish-audio/drama-3";

function cloneProvider(): string {
  return process.env.CLONE_TTS_PROVIDER?.trim().toLowerCase() || "";
}

export function usesOpenRouterClone(catalogVoiceId?: string | null): boolean {
  return cloneProvider() === "openrouter" && Boolean(catalogVoiceId?.startsWith("clone:"));
}

/**
 * Drama 3 as the fallback behind the self-hosted path. Modal is the default
 * clone provider (when configured), so this covers the default case as well as
 * an explicit `CLONE_TTS_PROVIDER=modal`.
 */
export function usesOpenRouterCloneFallback(catalogVoiceId?: string | null): boolean {
  if (!Boolean(catalogVoiceId?.startsWith("clone:"))) return false;
  const provider = cloneProvider();
  return provider === "" || provider === "modal";
}

/** Buffer before returning so a failed stream can fall back before any bytes escape. */
export async function openOpenRouterCloneStream(input: SynthesizeInput): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  input.signal?.throwIfAborted();
  const { queryOne } = await import("@/lib/turso");
  const { downloadFile } = await import("@/lib/storage");
  const clone = await queryOne<{ sample_storage_path: string | null }>(
    `SELECT sample_storage_path FROM cloned_voices
     WHERE id = ? AND fish_voice_id = ? AND deleted_at IS NULL LIMIT 1`,
    [input.catalogVoiceId!.slice("clone:".length), input.voiceId]
  );
  if (!clone?.sample_storage_path) throw new Error("Clone reference sample is unavailable");
  const sample = await downloadFile(clone.sample_storage_path);
  if (!sample.length || sample.length > 15 * 1024 * 1024) {
    throw new Error("Clone reference must be between 1 byte and 15 MiB");
  }
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Echomancer",
    },
    body: JSON.stringify({
      model: OPENROUTER_CLONE_MODEL,
      input: input.text,
      response_format: "mp3",
      input_references: [{
        type: "input_audio",
        input_audio: { data: sample.toString("base64") },
      }],
    }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenRouter clone TTS ${response.status}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || sniffAudioContentType(audio) !== "audio/mpeg") {
    throw new Error("OpenRouter clone returned invalid MP3 audio");
  }
  return new Response(new Uint8Array(audio), {
    headers: { "Content-Type": "audio/mpeg" },
  });
}
