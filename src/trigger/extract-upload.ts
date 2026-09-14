/**
 * Extract no longer runs on Trigger. Whole-book TTS prefers the VM
 * worker; `takehome.advance` remains an optional fallback. This file
 * keeps `upload.extract` / `upload.drain`
 * registered so an old Trigger dashboard cron cannot enqueue a cold
 * parse path — drain is a no-op.
 */

import { schedules, task } from "@trigger.dev/sdk";

export const uploadExtract = task({
  id: "upload.extract",
  maxDuration: 60,
  run: async (payload: { uploadId?: string }) => {
    console.info(
      `[upload.extract] ignored upload ${payload?.uploadId ?? "?"} — extract runs on Cloudflare Workers / Vercel, not Trigger`
    );
    return { ignored: true, reason: "extract-off-trigger" };
  },
});

export const uploadDrain = schedules.task({
  id: "upload.drain",
  cron: "* * * * *",
  run: async () => {
    return { triggered: 0, reason: "extract-off-trigger" };
  },
});
