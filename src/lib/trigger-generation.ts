/**
 * Shared Modal audiobook-generation trigger.
 *
 * Used by POST /api/jobs and PATCH /api/jobs/[id] (retry).
 * Awaits Modal's accept response so Vercel serverless doesn't kill the
 * outbound request before it is sent.
 */

import {
  type MossAbVariant,
  resolveTtsRoute,
} from "@/lib/tts-config";
import type { VoiceClipRange } from "@/lib/voice-clips";

export interface TriggerGenerationOptions {
  jobId: string;
  pdfStoragePath: string;
  voiceStoragePath: string | null;
  startTime: number;
  endTime: number;
  bookTitle: string;
  voiceName: string;
  /** MOSS language tag. Default: English */
  mossLanguage?: string;
  /** Extracted book size used for hybrid short/full-book routing. */
  charCount?: number | null;
  paragraphCount?: number | null;
  /** Persisted route. Keeps retries on the same backend. */
  mossAbVariant?: MossAbVariant | null;
  voiceClips?: VoiceClipRange[];
  styleSelectionSeed?: number;
}

function modalUrlEnvName(variant: MossAbVariant): string {
  if (variant === "api") return "MODAL_MOSS_API_TTS_URL";
  if (variant === "sglang") return "MODAL_MOSS_SGLANG_TTS_URL";
  if (variant === "local") return "MODAL_MOSS_LOCAL_TTS_URL";
  if (variant === "openmoss") return "MODAL_MOSS_OPENMOSS_TTS_URL";
  return "MODAL_MOSS_DELAY_TTS_URL or MODAL_MOSS_TTS_URL";
}

export async function triggerAudiobookGeneration(opts: TriggerGenerationOptions): Promise<void> {
  const route = resolveTtsRoute(
    "audiobook",
    { charCount: opts.charCount, paragraphCount: opts.paragraphCount },
    opts.mossAbVariant
  );
  const mossVariant = route.variant;
  const modalUrl = route.batchUrl;

  if (!modalUrl) {
    throw new Error(
      `${modalUrlEnvName(mossVariant)} is not configured for moss/${mossVariant}`
    );
  }

  if (!modalUrl.startsWith("https://")) {
    throw new Error("Modal TTS URL must use https://");
  }

  const baseUrl = modalUrl.replace("/generate_batch", "");

  const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const appUrl =
    rawAppUrl.includes("localhost") || rawAppUrl.includes("ngrok")
      ? "https://echomancer-v2.vercel.app"
      : rawAppUrl;

  const voicePaths = opts.voiceStoragePath
    ? opts.voiceStoragePath.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  const webhookUrl = `${appUrl}/api/jobs/${opts.jobId}/webhook`;
  console.log(
    `[Job ${opts.jobId}] Triggering Modal (moss/${mossVariant}) at ${baseUrl}/generate_audiobook, webhook=${webhookUrl}`
  );

  const payload: Record<string, unknown> = {
    job_id: opts.jobId,
    pdf_r2_key: opts.pdfStoragePath,
    voice_r2_key: voicePaths[0] || "",
    start_time: opts.startTime,
    end_time: opts.endTime,
    webhook_url: webhookUrl,
    book_title: opts.bookTitle,
    voice_name: opts.voiceName,
    r2_bucket_name: process.env.R2_BUCKET_NAME || "echomancer-audio",
    pipeline_mode: "moss",
    tts_variant: mossVariant,
    moss_language: opts.mossLanguage ?? process.env.MOSS_TTS_LANGUAGE ?? "English",
    narration_instructions:
      process.env.MOSS_NARRATION_INSTRUCTIONS ??
      "Expressive audiobook narration with natural warmth, varied intonation, and unhurried pacing.",
    paragraph_pause_sec: Number(process.env.MOSS_PARAGRAPH_PAUSE_SEC ?? "0.65"),
    sentence_pause_sec: Number(process.env.MOSS_SENTENCE_PAUSE_SEC ?? "0.22"),
    audio_temperature: Number(process.env.MOSS_AUDIO_TEMPERATURE ?? "1.82"),
    audio_top_p: Number(process.env.MOSS_AUDIO_TOP_P ?? "0.8"),
    audio_top_k: Number(process.env.MOSS_AUDIO_TOP_K ?? "25"),
    reference_segments: opts.voiceClips?.map((clip) => ({
      label: clip.label,
      start_time: clip.startTime,
      end_time: clip.endTime,
    })),
    style_selection_seed: opts.styleSelectionSeed ?? 42,
    synthesis_contract:
      mossVariant === "openmoss" ? "openmoss-q8-sentence-v1" : undefined,
  };

  try {
    const res = await fetch(`${baseUrl}/generate_audiobook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TTS-Trigger-Secret":
          process.env.TTS_TRIGGER_SECRET ?? process.env.WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      throw new Error(
        `Modal returned ${res.status}: ${text.slice(0, 500)}`
      );
    } else {
      console.log(`[Job ${opts.jobId}] Modal accepted job`);
    }
  } catch (err) {
    console.error(`[Job ${opts.jobId}] Failed to trigger Modal:`, err);
    throw err;
  }
}