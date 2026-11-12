/**
 * Voice-list and extract used to start `modal run …::cover` before a book
 * existed. That input restores a container the later `/synthesize_batch`
 * does not join while the restore is in progress, so the cover idles for
 * the whole scaledown window. Both callers stay, and both return false
 * without spawning. The book's synthesize call is the container it uses.
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
