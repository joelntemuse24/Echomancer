/**
 * Shared Modal audiobook-generation trigger.
 *
 * Single source of truth used by BOTH:
 *  - POST /api/jobs          (new job)
 *  - PATCH /api/jobs/[id]    (retry of a failed job)
 *
 * Keeping this in one place prevents the two call sites from drifting apart
 * (the retry path previously reset the job but never re-triggered the worker).
 *
 * Awaits the Modal trigger request: on Vercel serverless the function can be
 * frozen/killed once the HTTP response is sent, so a fire-and-forget fetch may
 * never actually reach Modal. Awaiting ensures the request is sent and accepted
 * before we respond. Never throws — failures are logged and the webhook flow
 * reports real status back to the job record.
 */

export interface TriggerGenerationOptions {
  jobId: string;
  pdfStoragePath: string;
  voiceStoragePath: string | null;
  startTime: number;
  endTime: number;
  bookTitle: string;
  voiceName: string;
}

export async function triggerAudiobookGeneration(opts: TriggerGenerationOptions): Promise<void> {
  const modalUrl = process.env.MODAL_TTS_URL;

  if (!modalUrl) {
    console.error(
      `[Job ${opts.jobId}] MODAL_TTS_URL not configured — job queued but not sent to worker`
    );
    return;
  }

  if (!modalUrl.startsWith("https://")) {
    console.error(`[Job ${opts.jobId}] MODAL_TTS_URL must use https://`);
  }

  const baseUrl = modalUrl.replace("/generate_batch", "");

  // Production-safe fallback: never send webhooks to localhost or stale ngrok
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
    `[Job ${opts.jobId}] Triggering Modal at ${baseUrl}/generate_audiobook, webhook=${webhookUrl}`
  );

  try {
    const res = await fetch(`${baseUrl}/generate_audiobook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: opts.jobId,
        pdf_r2_key: opts.pdfStoragePath,
        voice_r2_key: voicePaths[0] || "",
        start_time: opts.startTime,
        end_time: opts.endTime,
        webhook_url: webhookUrl,
        book_title: opts.bookTitle,
        voice_name: opts.voiceName,
        r2_bucket_name: process.env.R2_BUCKET_NAME || "echomancer-audio",
      }),
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
