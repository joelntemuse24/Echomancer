/**
 * Shared Modal audiobook-generation trigger.
 *
 * Used by POST /api/jobs and PATCH /api/jobs/[id] (retry).
 * Awaits Modal's accept response so Vercel serverless doesn't kill the
 * outbound request before it is sent.
 */

import {
  resolveModalBatchUrl,
  resolveMossAbVariant,
} from "@/lib/tts-config";

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
}

function modalUrlEnvName(): string {
  const variant = resolveMossAbVariant();
  if (variant === "api") return "MODAL_MOSS_API_TTS_URL";
  if (variant === "sglang") return "MODAL_MOSS_SGLANG_TTS_URL";
  if (variant === "local") return "MODAL_MOSS_LOCAL_TTS_URL";
  return "MODAL_MOSS_TTS_URL";
}

export async function triggerAudiobookGeneration(opts: TriggerGenerationOptions): Promise<void> {
  const mossVariant = resolveMossAbVariant();
  const modalUrl = resolveModalBatchUrl();

  if (!modalUrl) {
    console.error(
      `[Job ${opts.jobId}] ${modalUrlEnvName()} not configured — job queued but not sent to worker`
    );
    return;
  }

  if (!modalUrl.startsWith("https://")) {
    console.error(`[Job ${opts.jobId}] Modal TTS URL must use https://`);
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

  const payload: Record<string, string | number> = {
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
    moss_language: opts.mossLanguage ?? process.env.MOSS_TTS_LANGUAGE ?? "English",
  };

  try {
    const res = await fetch(`${baseUrl}/generate_audiobook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      console.error(
        `[Job ${opts.jobId}] Modal returned ${res.status}: ${text.slice(0, 500)}`
      );
    } else {
      console.log(`[Job ${opts.jobId}] Modal accepted job`);
    }
  } catch (err) {
    console.error(`[Job ${opts.jobId}] Failed to trigger Modal:`, err);
  }
}