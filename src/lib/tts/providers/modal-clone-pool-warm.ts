/**
 * Start a scale-to-zero GPU restore before the person presses go.
 *
 * A cold first section is ~57s of snapshot restore plus ~14s of one-row
 * synthesis. The restore only has to sit on that clock if it starts when
 * the synth call does. Starting it while the file is being read, or while
 * the voice list is on screen, lands a warm container before section 0
 * whenever that gap is longer than the restore and shorter than
 * `scaledown_window` (production: 180s after the container goes idle).
 *
 * A restore that is still in progress does not help. Modal will not attach
 * the later HTTP call to a container that has not finished booting, so a
 * fast click still pays a full cold start and the prewarm is spent for
 * nothing. `min_containers` stays 0.
 *
 * Stock-only accounts never start a GPU. The same 3-minute cooldown as
 * `prewarmModalCloneSnapshot` keeps a voice-list refresh from stacking a
 * second container on top of the one extract just started.
 */

import { queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { getUploadById } from "@/lib/turso/uploads";
import { usesModalClone } from "@/lib/tts/providers/modal-clone";
import { prewarmModalCloneSnapshot } from "@/lib/tts/providers/modal-clone-warm";

/** Fish writes this once training has a reference id. Anything else is not a voice yet. */
const TRAINED_CLONE_STATE = "trained";

export async function userHasTrainedClone(userId: string): Promise<boolean> {
  if (!userId.startsWith("user_")) return false;
  await ensureTtsJobColumns();
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM cloned_voices
     WHERE user_id = ? AND deleted_at IS NULL AND state = ?
     LIMIT 1`,
    [userId, TRAINED_CLONE_STATE]
  );
  return Boolean(row?.id);
}

/**
 * Restore one container for this person, if they already have a trained
 * clone and this process is the Modal engine. Returns false when there is
 * nothing to warm, the hook is off, or the cooldown already claimed a start.
 * Never throws.
 */
export async function prewarmClonePoolForUser(
  userId: string,
  reason: string
): Promise<boolean> {
  try {
    if (!usesModalClone("clone:pool")) return false;
    if (!(await userHasTrainedClone(userId))) return false;
    return prewarmModalCloneSnapshot(reason);
  } catch (err) {
    console.warn(
      "[modal-clone] clone-pool prewarm failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Extract was just accepted. The read is tens of seconds for a real file,
 * which is most of a restore, so this is the earliest moment a container
 * can be warm before the voice is even chosen.
 */
export async function prewarmClonePoolForUpload(uploadId: string): Promise<boolean> {
  try {
    const upload = await getUploadById(uploadId);
    if (!upload?.user_id) return false;
    return await prewarmClonePoolForUser(
      upload.user_id,
      `upload ${uploadId} is being read`
    );
  } catch (err) {
    console.warn(
      "[modal-clone] clone-pool prewarm failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
