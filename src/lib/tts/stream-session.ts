/**
 * Live stream session: walk book text from cursor, pipe provider audio.
 */

import { downloadFile } from "@/lib/storage";
import { execute, queryOne } from "@/lib/turso";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import { streamMaxChars } from "@/lib/tts/pricing";
import { splitTextForTts } from "@/lib/tts/split-text";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { logUsage } from "@/lib/turso/jobs";

const STALE_PROCESSING_SECONDS = 330;

export async function createStreamAudioIterator(
  jobId: string,
  signal?: AbortSignal
): Promise<{
  contentType: string;
  iterator: AsyncGenerator<Uint8Array, void, unknown>;
}> {
  await ensureTtsJobColumns();

  const job = await queryOne<{
    id: string;
    pdf_storage_path: string;
    tts_provider: string | null;
    provider_voice_id: string | null;
    catalog_voice_id: string | null;
    tts_options: string | null;
    stream_cursor: number | null;
    stream_chars_used: number | null;
    stream_max_chars: number | null;
    job_kind: string | null;
    status: string;
  }>(
    `SELECT id, pdf_storage_path, tts_provider, provider_voice_id, catalog_voice_id,
            tts_options, stream_cursor, stream_chars_used, stream_max_chars, job_kind, status
     FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );

  if (!job) throw new Error("Job not found");
  if (job.job_kind && job.job_kind !== "stream") {
    throw new Error("Not a stream session job");
  }
  // L4: Don't reopen failed stream jobs
  if (job.status === "failed") {
    throw new Error("Stream session has failed and cannot be reopened");
  }

  const providerId = job.tts_provider || "";
  if (!isStockProvider(providerId)) {
    throw new Error(`Invalid provider: ${providerId}`);
  }

  const catalog = job.catalog_voice_id
    ? await getCatalogVoice(job.catalog_voice_id, { hdEnabled: true })
    : undefined;
  const voiceId = job.provider_voice_id || catalog?.providerVoiceId;
  if (!voiceId) throw new Error("Missing voice id");

  let ttsOptions: { model?: string } = {};
  if (job.tts_options) {
    try {
      ttsOptions = JSON.parse(job.tts_options) as { model?: string };
    } catch {
      /* ignore */
    }
  }
  const modelSlug = ttsOptions.model || catalog?.model;
  const text = (await downloadFile(job.pdf_storage_path)).toString("utf-8");
  const maxBudget = job.stream_max_chars || streamMaxChars();
  const cursor = job.stream_cursor || 0;
  const used = job.stream_chars_used || 0;

  if (used >= maxBudget || cursor >= text.length) {
    throw new Error("Stream budget exhausted or book finished");
  }

  const maxWindow =
    catalog?.maxCharsPerRequest ||
    (modelSlug?.includes("openai")
      ? 4000
      : modelSlug?.includes("gemini")
        ? 3000
        : modelSlug?.includes("zonos")
          ? 350
          : modelSlug?.includes("kokoro")
            ? 800
            : providerId === "grok"
              ? 8000
              : providerId === "gemini"
                ? 2500
                : 2000);

  const remainingBudget = maxBudget - used;
  const slice = text.slice(cursor, cursor + remainingBudget);
  const windows = splitTextForTts(slice, maxWindow);

  const provider = resolveStockAdapter({
    provider: providerId,
    model: modelSlug,
  });

  // H6: Prevent concurrent streams — atomic claim
  const streamClaim = await execute(
    `UPDATE jobs SET status = 'processing', processing_started_at = unixepoch(),
     updated_at = unixepoch()
     WHERE id = ? AND (
       status IN ('queued', 'ready')
       OR (status = 'processing' AND processing_started_at IS NOT NULL
           AND unixepoch() - processing_started_at > ?)
     )`,
    [jobId, STALE_PROCESSING_SECONDS]
  );
  if (!streamClaim || streamClaim.rowsAffected === 0) {
    throw new Error("Stream session is not in a streamable state");
  }

  async function* iterate(): AsyncGenerator<Uint8Array, void, unknown> {
    let localCursor = cursor;
    let localUsed = used;

    try {
      for (const window of windows) {
        if (signal?.aborted) break;
        if (localUsed >= maxBudget) break;

        const stream = provider.synthesizeStream({
          text: window,
          voiceId: voiceId!,
          language: catalog?.locale,
          model: modelSlug,
          stylePrompt:
            "Narrate this audiobook passage clearly with natural pacing.",
          signal,
        });

        let windowDelivered = false;
        for await (const chunk of stream) {
          if (signal?.aborted) break;
          yield chunk;
          windowDelivered = true;
        }

        // M4: Only advance cursor/budget if the full window was delivered
        if (!signal?.aborted) {
          localCursor += window.length;
          localUsed += window.length;
        } else if (windowDelivered) {
          // Partial delivery — count what was actually sent
          localCursor += window.length;
          localUsed += window.length;
        }

        await execute(
          `UPDATE jobs SET stream_cursor = ?, stream_chars_used = ?,
           progress = ?, updated_at = unixepoch() WHERE id = ?`,
          [
            Math.min(localCursor, text.length),
            Math.min(localUsed, maxBudget),
            Math.min(99, Math.round((localUsed / maxBudget) * 100)),
            jobId,
          ]
        );
      }

      const finishedBook = localCursor >= text.length;
      const budgetDone = localUsed >= maxBudget;
      const aborted = signal?.aborted;

      await execute(
        `UPDATE jobs SET status = ?, progress = ?, stream_cursor = ?,
         stream_chars_used = ?, processing_started_at = NULL,
         updated_at = unixepoch() WHERE id = ?`,
        [
          aborted
            ? (finishedBook || budgetDone ? "ready" : "queued")
            : (finishedBook || budgetDone ? "ready" : "queued"),
          finishedBook || budgetDone ? 100 : Math.min(99, Math.round((localUsed / maxBudget) * 100)),
          localCursor,
          localUsed,
          jobId,
        ]
      );

      if (!aborted) {
        await logUsage({
          action: "stream_session",
          charsProcessed: localUsed - used,
        });
      }
    } catch (err) {
      // C3: Don't mark as failed on client disconnect (AbortError)
      const isAbort = signal?.aborted || (err instanceof Error && /abort/i.test(err.name));
      if (isAbort) {
        await execute(
          `UPDATE jobs SET status = 'queued', stream_cursor = ?, stream_chars_used = ?,
           processing_started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
          [localCursor, localUsed, jobId]
        ).catch(() => {});
        return;
      }
      const message = err instanceof Error ? err.message : "Stream failed";
      await execute(
        `UPDATE jobs SET status = 'failed', error_message = ?,
         processing_started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
        [message, jobId]
      );
      throw err;
    }
  }

  // C5: Derive content type from provider instead of hardcoding
  const rawCt = provider.streamContentType;
  const contentType = typeof rawCt === "function"
    ? rawCt(modelSlug)
    : rawCt || "audio/mpeg";
  return { contentType, iterator: iterate() };
}
