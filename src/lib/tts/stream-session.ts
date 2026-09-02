/**
 * Live listen ("Try a chapter"): walk the book from a stored cursor and pipe
 * provider audio straight to the browser.
 *
 * Unlike take-home, nothing is stored — the cursor and character budget in the
 * `jobs` row are the only state. When the invocation times out, the player
 * reconnects and we resume from `stream_cursor`.
 *
 * The cursor is only advanced for windows that actually produced audible bytes.
 * Counting a silent window as delivered would skip that slice of the book
 * permanently *and* charge it against the listening budget.
 */

import { downloadFile } from "@/lib/storage";
import { execute, queryOne } from "@/lib/turso";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isStockProvider, resolveStockAdapter } from "@/lib/tts/providers";
import { streamMaxChars } from "@/lib/tts/pricing";
import { splitTextForTts } from "@/lib/tts/split-text";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { createWavHeader, isRawPcmContentType } from "@/lib/tts/pcm-wav";
import { logUsage } from "@/lib/turso/jobs";
import {
  MIN_AUDIBLE_BYTES,
  hasNonZeroByte,
  isEmptyOrSilentStreamPayload,
} from "@/lib/tts/audio-guard";
import { maxCharsForModel, streamWindowChars } from "@/lib/tts/section-size";

/** A stream holds its claim for roughly one full invocation. */
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
    user_id: string;
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
    `SELECT id, user_id, pdf_storage_path, tts_provider, provider_voice_id,
            catalog_voice_id, tts_options, stream_cursor, stream_chars_used,
            stream_max_chars, job_kind, status
     FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );

  if (!job) throw new Error("Job not found");
  if (job.job_kind && job.job_kind !== "stream") {
    throw new Error("Not a stream session job");
  }
  if (job.status === "failed") {
    throw new Error("Stream session has failed and cannot be reopened");
  }

  const providerId = job.tts_provider || "";
  if (!isStockProvider(providerId)) {
    throw new Error(`Invalid provider: ${providerId}`);
  }

  const catalog = job.catalog_voice_id
    ? await getCatalogVoice(job.catalog_voice_id, {
        hdEnabled: true,
        userId: job.user_id,
      })
    : undefined;
  const voiceId = job.provider_voice_id || catalog?.providerVoiceId;
  if (!voiceId) throw new Error("Missing voice id");

  let ttsOptions: { model?: string; stylePrompt?: string } = {};
  if (job.tts_options) {
    try {
      ttsOptions = JSON.parse(job.tts_options) as {
        model?: string;
        stylePrompt?: string;
      };
    } catch {
      /* ignore malformed options */
    }
  }

  const modelSlug = ttsOptions.model || catalog?.model;
  const text = (await downloadFile(job.pdf_storage_path)).toString("utf-8");
  const maxBudget = job.stream_max_chars || streamMaxChars();
  const cursor = job.stream_cursor || 0;
  const used = job.stream_chars_used || 0;

  if (cursor >= text.length) {
    throw new Error("Stream finished — end of book");
  }
  if (used >= maxBudget) {
    throw new Error("Stream budget exhausted");
  }

  const windowChars = streamWindowChars(
    maxCharsForModel({
      provider: providerId,
      model: modelSlug,
      catalogMax: catalog?.maxCharsPerRequest,
    })
  );

  const slice = text.slice(cursor, cursor + (maxBudget - used));
  const windows = splitTextForTts(slice, windowChars);

  const provider = resolveStockAdapter({
    provider: providerId,
    model: modelSlug,
    catalogVoiceId: job.catalog_voice_id,
  });

  // Only one reader per session: two concurrent streams would both advance the
  // cursor and bill the budget twice.
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
  if (streamClaim.rowsAffected === 0) {
    console.error(`[stream-session ${jobId}] claim failed — status=${job.status}`);
    throw new Error("Stream session is not in a streamable state");
  }

  const rawContentType = provider.streamContentType;
  const wireContentType =
    (typeof rawContentType === "function"
      ? rawContentType(modelSlug)
      : rawContentType) || "audio/mpeg";
  const pcmStream = isRawPcmContentType(wireContentType);
  const contentType = pcmStream ? "audio/wav" : wireContentType;

  async function* iterate(): AsyncGenerator<Uint8Array, void, unknown> {
    let localCursor = cursor;
    let localUsed = used;
    let wavHeaderSent = false;
    let silentWindows = 0;

    try {
      for (const window of windows) {
        if (signal?.aborted) break;
        if (localUsed >= maxBudget) break;

        const { resolveStylePrompt } = await import(
          "@/lib/tts/resolve-style-prompt"
        );
        const {
          geminiDirectedInput,
          modelSupportsAccentVariants,
          modelSupportsStyleInstructions,
        } = await import("@/lib/tts/accent-prompt");
        const modelId = modelSlug || catalog?.model || "";
        const accent =
          catalog?.accentHint ||
          (catalog as { accent?: string } | undefined)?.accent ||
          undefined;
        const supportsDirection = modelSupportsAccentVariants(modelId);
        const supportsStyle = modelSupportsStyleInstructions(modelId);

        // Attempt 0 uses accent direction; the retry drops it, because
        // over-steered input is a known cause of empty provider responses.
        let delivered = { bytes: 0, audible: false };
        for (let attempt = 0; attempt < 2; attempt++) {
          const useDirection = supportsDirection && attempt === 0;
          const stream = provider.synthesizeStream({
            text: useDirection ? geminiDirectedInput(window, accent) : window,
            voiceId: voiceId!,
            catalogVoiceId: job.catalog_voice_id,
            language: catalog?.locale,
            model: modelSlug,
            stylePrompt:
              supportsDirection || !supportsStyle || attempt > 0
                ? undefined
                : resolveStylePrompt({
                    catalogStylePrompt: catalog?.stylePrompt,
                    ttsOptionsStylePrompt: ttsOptions.stylePrompt,
                    locale: catalog?.locale,
                  }),
            signal,
          });

          const buffered: Uint8Array[] = [];
          let bytes = 0;
          let audible = false;
          for await (const chunk of stream) {
            if (signal?.aborted) break;
            buffered.push(chunk);
            bytes += chunk.length;
            if (!audible && hasNonZeroByte(chunk)) audible = true;
            // Once we know the window is real, stop buffering and pass through
            // so time-to-first-sound is not hurt by the guard.
            if (audible && bytes >= MIN_AUDIBLE_BYTES) break;
          }

          if (
            !signal?.aborted &&
            isEmptyOrSilentStreamPayload(bytes, audible) &&
            attempt === 0
          ) {
            console.warn(
              `[stream-session ${jobId}] silent window at cursor ${localCursor} — retrying undirected`
            );
            continue;
          }

          if (pcmStream && !wavHeaderSent && bytes > 0) {
            yield new Uint8Array(createWavHeader(0x7fffffff));
            wavHeaderSent = true;
          }
          for (const chunk of buffered) yield chunk;

          // Pass the remainder of the window straight through.
          if (!signal?.aborted && audible) {
            for await (const chunk of stream) {
              if (signal?.aborted) break;
              bytes += chunk.length;
              yield chunk;
            }
          }

          delivered = { bytes, audible };
          break;
        }

        if (isEmptyOrSilentStreamPayload(delivered.bytes, delivered.audible)) {
          silentWindows += 1;
          console.error(
            `[stream-session ${jobId}] window produced no audible audio (${silentWindows})`
          );
          // Do not advance the cursor: the text was never actually narrated.
          throw new Error("Narrator returned no audio for this passage");
        }

        localCursor += window.length;
        localUsed += window.length;

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

      const finished = localCursor >= text.length || localUsed >= maxBudget;

      await execute(
        `UPDATE jobs SET status = ?, progress = ?, stream_cursor = ?,
         stream_chars_used = ?, processing_started_at = NULL,
         updated_at = unixepoch() WHERE id = ?`,
        [
          finished ? "ready" : "queued",
          finished
            ? 100
            : Math.min(99, Math.round((localUsed / maxBudget) * 100)),
          localCursor,
          localUsed,
          jobId,
        ]
      );

      if (!signal?.aborted) {
        await logUsage({
          userId: job!.user_id,
          action: "stream_session",
          charsProcessed: localUsed - used,
        });
      }
    } catch (err) {
      // A client hanging up is not a failure — park the session so the player
      // can reconnect where it left off.
      const isAbort =
        signal?.aborted || (err instanceof Error && /abort/i.test(err.name));
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
      ).catch(() => {});
      throw err;
    }
  }

  return { contentType, iterator: iterate() };
}
