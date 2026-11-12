/**
 * Extract no longer runs on Trigger. Whole-book TTS prefers the VM
 * worker; `takehome.advance` remains an optional fallback. `upload.extract`
 * stays a no-op so a trigger of that id does not run an older parse.
 * `upload.drain` is not a task. Deploying this file to Trigger production
 * deletes its declarative minute cron.
 */

import { task } from "@trigger.dev/sdk";

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
