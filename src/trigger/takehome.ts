/**
 * Optional Trigger.dev host for Whole-book generation.
 *
 * Preferred host is the always-on VM (`src/worker/takehome-server.ts`)
 * when `WORKER_URL` is set. `takehome.advance` stays as a fallback
 * (`TAKEHOME_TRIGGER_FALLBACK=1` or no worker URL). `takehome.drain` is
 * not a task. Deploying this file to Trigger production deletes that
 * declarative minute cron, because the worker manifest no longer declares
 * it. The VM drain claims queued and waiting books.
 *
 * `takehome.advance` imports the existing worker in-process — it does not
 * HTTP `POST /api/jobs/[id]/process`. Live Listen / Live Stream stay on Vercel.
 * Extract does not run here.
 */

import { task } from "@trigger.dev/sdk";
import { assertTakehomeWorkerSecrets } from "@/lib/jobs/trigger-secrets";
import {
  DEFAULT_TRIGGER_WAVE_BUDGET_MS,
  runTakehomeUntilSettled,
} from "@/lib/tts/process-job";

export const takehomeAdvance = task({
  id: "takehome.advance",
  maxDuration: 3600,
  // DFN3 holds float WAV buffers; default small-1x is 0.5 GB and OOMs a book.
  machine: "large-1x",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    outOfMemory: { machine: "large-2x" },
  },
  run: async (payload: { jobId: string }) => {
    assertTakehomeWorkerSecrets();
    const jobId = payload?.jobId;
    if (!jobId || typeof jobId !== "string") {
      throw new Error("takehome.advance requires { jobId }");
    }
    const budgetMs = Number(
      process.env.TTS_TRIGGER_WAVE_BUDGET_MS || DEFAULT_TRIGGER_WAVE_BUDGET_MS
    );
    return runTakehomeUntilSettled(jobId, budgetMs);
  },
});
