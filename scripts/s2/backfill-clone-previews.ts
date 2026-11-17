/**
 * Bake stored previews for clones that do not have one.
 *
 * Do not run this from a deploy. It calls the worker bake, which can
 * place a GPU. An operator runs it by hand after the cover step.
 *
 *   npx tsx scripts/s2/backfill-clone-previews.ts
 */

import { query } from "@/lib/turso";
import { bakeClonePreview } from "@/lib/tts/clone-preview-job";

async function main(): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM cloned_voices WHERE deleted_at IS NULL AND state = 'trained'`
  );
  console.info(`[backfill] ${rows.length} trained clone(s)`);
  for (const row of rows) {
    const response = await bakeClonePreview(row.id);
    console.info(`[backfill] ${row.id} ${response.status}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
