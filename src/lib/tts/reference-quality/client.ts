/**
 * Vercel side of the clone reference gate: ask the worker to score the
 * uploaded sample. Fails open (returns null) when the worker is not
 * configured, slow or down, so cloning never breaks because of the gate.
 */

import { takehomeWorkerSecret, takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import type { ReferenceQualityReport } from "@/lib/tts/reference-quality/score";

export type WorkerReferenceCheck = {
  report: ReferenceQualityReport;
  remasteredPath: string | null;
  ms: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export async function requestReferenceCheck(
  input: { uploadId: string; samplePath: string; remasterFailing?: boolean },
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
): Promise<WorkerReferenceCheck | null> {
  const env = deps.env ?? process.env;
  if (env.REFERENCE_QUALITY_GATE === "0") return null;
  const url = takehomeWorkerUrl();
  const secret = takehomeWorkerSecret();
  if (!url || !secret) return null;
  const timeoutMs = Number(env.REFERENCE_QUALITY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${url}/reference-quality`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[reference-quality] worker ${res.status} for ${input.uploadId}`);
      return null;
    }
    const data = (await res.json()) as { ok?: boolean; result?: WorkerReferenceCheck | null };
    return data.result?.report ? data.result : null;
  } catch (err) {
    console.warn(`[reference-quality] worker unreachable for ${input.uploadId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
