/**
 * Fill empty reference transcripts. Do not run this from a deploy.
 *
 *   npx tsx scripts/s2/backfill-clone-transcripts.ts
 */

import { downloadFile } from "@/lib/storage";
import { query } from "@/lib/turso";
import { ensureCloneReferenceTranscript } from "@/lib/tts/clone-reference-transcript";

async function main(): Promise<void> {
  const rows = await query<{ id: string; sample_storage_path: string | null }>(
    `SELECT id, sample_storage_path FROM cloned_voices
     WHERE deleted_at IS NULL
       AND (reference_transcript IS NULL OR length(trim(reference_transcript)) = 0)`
  );
  console.info(`[backfill] ${rows.length} clone(s) without a transcript`);
  for (const row of rows) {
    if (!row.sample_storage_path) {
      console.info(`[backfill] ${row.id} has no sample`);
      continue;
    }
    const audio = await downloadFile(row.sample_storage_path);
    const text = await ensureCloneReferenceTranscript({ cloneId: row.id, audio });
    console.info(`[backfill] ${row.id} chars=${text.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
