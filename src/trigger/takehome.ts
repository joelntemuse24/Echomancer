/**
 * Trigger.dev Cloud host for Whole-book generation.
 *
 * `takehome.advance` imports the existing worker in-process — it does not
 * HTTP `POST /api/jobs/[id]/process`. Live Listen / Live Stream stay on Vercel.
 */

import { schedules, task } from "@trigger.dev/sdk";
import { assertTakehomeWorkerSecrets } from "@/lib/jobs/trigger-secrets";
import {
  DEFAULT_TRIGGER_WAVE_BUDGET_MS,
  listDrainableTakehomeJobs,
  releaseExpiredTakehomeLeases,
  runTakehomeUntilSettled,
} from "@/lib/tts/process-job";

export const takehomeAdvance = task({
  id: "takehome.advance",
  maxDuration: 3600,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30_000,
    factor: 2,
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

export const takehomeDrain = schedules.task({
  id: "takehome.drain",
  cron: "* * * * *",
  run: async () => {
    assertTakehomeWorkerSecrets();
    await releaseExpiredTakehomeLeases();
    const ids = [...new Set(await listDrainableTakehomeJobs())];
    for (const jobId of ids) {
      await takehomeAdvance.trigger({ jobId }, { concurrencyKey: jobId });
    }
    return { triggered: ids.length, jobIds: ids };
  },
});
