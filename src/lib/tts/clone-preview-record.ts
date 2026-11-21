/**
 * Remember whether a clone already has a stored preview.
 *
 * The voices list used to stat storage for every clone on every request.
 * A hit is the object key. A miss is `""` plus a clock, so the next list
 * skips storage until that clock is old. A later bake writes the real key
 * and clears the clock.
 */

import { execute } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";

/** Stored when a lookup found no clip. Distinct from NULL (never looked). */
export const CLONE_PREVIEW_PATH_ABSENT = "";

/**
 * How long a miss stands. A bake that finishes writes the key itself, so
 * this only covers a lookup that ran before the file existed.
 */
export const CLONE_PREVIEW_ABSENT_TTL_SEC = 10 * 60;

export async function rememberClonePreviewPath(
  rowId: string,
  storagePath: string
): Promise<void> {
  if (!rowId || !storagePath) return;
  await ensureTtsJobColumns();
  await execute(
    `UPDATE cloned_voices
     SET preview_storage_path = ?, preview_probed_at = NULL
     WHERE id = ? AND deleted_at IS NULL`,
    [storagePath, rowId]
  ).catch(() => {});
}

/**
 * Record a miss without erasing a key another request stored in the meantime.
 * `previous` is the value this lookup started from.
 */
export async function rememberClonePreviewMiss(
  rowId: string,
  previous: string | null | undefined,
  nowSec: number
): Promise<void> {
  if (!rowId) return;
  await ensureTtsJobColumns();
  const prior = previous ?? null;
  await execute(
    `UPDATE cloned_voices
     SET preview_storage_path = ?, preview_probed_at = ?
     WHERE id = ? AND deleted_at IS NULL
       AND (
         (? IS NULL AND preview_storage_path IS NULL)
         OR preview_storage_path = ?
       )`,
    [CLONE_PREVIEW_PATH_ABSENT, nowSec, rowId, prior, prior]
  ).catch(() => {});
}
