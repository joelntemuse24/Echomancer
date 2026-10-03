/**
 * The browser half of "Make audiobook": one POST that must return fast.
 *
 * The old flow polled extraction to readiness *before* creating the job, so
 * the button could spin for the whole extract (and die on one dropped poll).
 * Now the job is created immediately — even while the text is still being
 * extracted — and the player page shows that progress instead. The POST is
 * bounded: a hang or a dropped request surfaces as a visible error, never
 * a raw "Failed to fetch".
 */

import { userFriendlyError } from "@/lib/errors-ui";

export const JOB_CREATE_TIMEOUT_MS = 20_000;

export const JOB_CREATE_TIMEOUT_ERROR =
  "Couldn't start. Check your connection and try again.";

export interface StartStockBookInput {
  pdfStoragePath: string;
  bookTitle: string;
  catalogVoiceId: string;
  voiceName: string;
  charCount?: number;
  ttsOptions?: Record<string, unknown>;
  /** How long to wait for the enqueue response. Default 20 s. */
  timeoutMs?: number;
}

export interface StartedStockBook {
  jobId: string;
  status: string;
  /** A live book already existed; this tap did not start a second one. */
  duplicate: boolean;
}

export async function startStockBook(
  input: StartStockBookInput
): Promise<StartedStockBook> {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(),
    input.timeoutMs ?? JOB_CREATE_TIMEOUT_MS
  );
  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "stock",
        jobKind: "takehome",
        pdfStoragePath: input.pdfStoragePath,
        bookTitle: input.bookTitle,
        catalogVoiceId: input.catalogVoiceId,
        voiceName: input.voiceName,
        charCount: input.charCount,
        ttsOptions: input.ttsOptions,
      }),
      signal: ac.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      jobId?: string;
      status?: string;
      duplicate?: boolean;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(
        userFriendlyError(data.error || "Couldn't start. Try again.")
      );
    }
    if (!data.jobId) {
      throw new Error(userFriendlyError("Couldn't start. Try again."));
    }
    return {
      jobId: data.jobId,
      status: data.status || "queued",
      duplicate: data.duplicate === true,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(JOB_CREATE_TIMEOUT_ERROR);
    }
    if (err instanceof TypeError) {
      throw new Error(JOB_CREATE_TIMEOUT_ERROR);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
