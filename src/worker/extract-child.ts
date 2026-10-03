/**
 * One document extract. Forked by `node-extract.ts` so the parent's
 * event loop stays free for Whole-book TTS. Same pipeline as the
 * Cloudflare Worker (`runUploadExtract`).
 */

import "@/worker/load-env";
import { extractUploadedDocument } from "@/lib/uploads/extract";

const uploadId = process.argv[2] || "";
if (!uploadId) {
  console.error("[extract] uploadId required");
  process.exit(2);
}

extractUploadedDocument(uploadId, { host: "node" })
  .then((view) => {
    console.info(
      `[extract] ${uploadId} ${view.status} chars=${view.charCount}`
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[extract] ${uploadId} crashed`, err);
    process.exit(1);
  });
