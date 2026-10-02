/**
 * Rebuild one Whole-book file from the section audio already in storage.
 * Does not synthesize, and does not delete section objects.
 *
 *   npx tsx scripts/refinalize-takehome.ts cc9ba6ef
 *
 * Loads `.env.worker` (or `WORKER_ENV_FILE`) the same way the VM worker does.
 * Refuses a job that is still held by a live lease, or that is missing a
 * section. A failed job with every section present is published as ready
 * after the new full.mp3 is uploaded.
 */
import "@/worker/load-env";

import { execute, query, queryOne } from "@/lib/turso";
import { materializeFullAudiobook } from "@/lib/tts/concat-audio";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { allIndexesReady, parseSegmentMap } from "@/lib/tts/section-index";

type JobRow = {
  id: string;
  status: string;
  segments_json: string | null;
  total_sections: number | null;
  processing_lease_token: string | null;
  lease_expires_at: number | null;
  tts_options: string | null;
};

async function main(): Promise<void> {
  const prefix = process.argv[2]?.trim();
  if (!prefix || prefix.startsWith("-")) {
    console.error("Usage: npx tsx scripts/refinalize-takehome.ts <jobId-or-prefix>");
    process.exit(1);
  }

  await ensureTtsJobColumns();

  const matches = await query<JobRow>(
    `SELECT id, status, segments_json, total_sections, processing_lease_token,
            lease_expires_at, tts_options
     FROM jobs
     WHERE deleted_at IS NULL AND (id = ? OR id LIKE ?)
     LIMIT 5`,
    [prefix, `${prefix}%`]
  );

  if (matches.length === 0) {
    console.error(`No job matches ${prefix}`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`More than one job matches ${prefix}:`);
    for (const row of matches) console.error(`  ${row.id} (${row.status})`);
    process.exit(1);
  }

  const job = matches[0]!;
  const leaseExpires = Number(job.lease_expires_at ?? 0);
  const held =
    job.status === "processing" &&
    Boolean(job.processing_lease_token) &&
    leaseExpires > Math.floor(Date.now() / 1000);
  if (held) {
    console.error(
      `${job.id} is still processing under a live lease. Wait until that lease expires before re-finalizing.`
    );
    process.exit(1);
  }

  const segments = parseSegmentMap(job.segments_json);
  const total = job.total_sections ?? segments.length;
  if (!allIndexesReady(segments, total)) {
    const ready = segments.filter((segment) => segment.status === "ready" && segment.path).length;
    console.error(
      `${job.id} has ${ready} ready section(s) of ${total}. Refusing to assemble a partial book or to synthesize the rest.`
    );
    process.exit(1);
  }

  let crossfadeMs: number | undefined;
  if (job.tts_options) {
    try {
      const parsed = JSON.parse(job.tts_options) as { crossfadeMs?: unknown };
      if (typeof parsed.crossfadeMs === "number") crossfadeMs = parsed.crossfadeMs;
    } catch {
      crossfadeMs = undefined;
    }
  }

  console.log(`Re-finalizing ${job.id} from ${total} stored sections (was ${job.status})`);
  const storagePath = await materializeFullAudiobook(job.id, segments, total, {
    crossfadeMs,
    allowHoles: false,
  });
  if (!storagePath) {
    console.error(`${job.id} could not be assembled from the stored sections.`);
    process.exit(1);
  }

  const published = await execute(
    `UPDATE jobs SET status = 'ready', progress = 100, audio_storage_path = ?,
       error_message = NULL, processing_lease_token = NULL, lease_expires_at = NULL,
       processing_started_at = NULL, updated_at = unixepoch()
     WHERE id = ? AND status != 'cancelled'`,
    [storagePath, job.id]
  );
  if (published.rowsAffected === 0) {
    console.error(
      `${job.id} was cancelled while the file was uploading. Left the new object at ${storagePath}.`
    );
    process.exit(1);
  }

  const after = await queryOne<{ status: string; audio_storage_path: string | null }>(
    `SELECT status, audio_storage_path FROM jobs WHERE id = ?`,
    [job.id]
  );
  console.log(`Ready ${after?.status} ${after?.audio_storage_path}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
