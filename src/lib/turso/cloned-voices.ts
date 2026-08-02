import { randomUUID } from "crypto";
import { execute, query, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import type { ClonedVoiceRow } from "@/lib/tts/fish-clone";

export async function listClonedVoicesForUser(
  userId: string
): Promise<ClonedVoiceRow[]> {
  await ensureTtsJobColumns();
  return query<ClonedVoiceRow>(
    `SELECT id, user_id, fish_voice_id, title, sample_storage_path, state, model, created_at, deleted_at
     FROM cloned_voices
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId]
  );
}

export async function getClonedVoiceForUser(
  userId: string,
  cloneId: string
): Promise<ClonedVoiceRow | null> {
  await ensureTtsJobColumns();
  return queryOne<ClonedVoiceRow>(
    `SELECT id, user_id, fish_voice_id, title, sample_storage_path, state, model, created_at, deleted_at
     FROM cloned_voices
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [cloneId, userId]
  );
}

export async function insertClonedVoice(opts: {
  id?: string;
  userId: string;
  fishVoiceId: string;
  title: string;
  sampleStoragePath?: string | null;
  state: string;
  model: string;
}): Promise<ClonedVoiceRow> {
  await ensureTtsJobColumns();
  const id = opts.id || randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await execute(
    `INSERT INTO cloned_voices
      (id, user_id, fish_voice_id, title, sample_storage_path, state, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.userId,
      opts.fishVoiceId,
      opts.title,
      opts.sampleStoragePath || null,
      opts.state,
      opts.model,
      now,
    ]
  );
  const row = await getClonedVoiceForUser(opts.userId, id);
  if (!row) throw new Error("Failed to read cloned voice after insert");
  return row;
}

export async function softDeleteClonedVoice(
  userId: string,
  cloneId: string
): Promise<boolean> {
  await ensureTtsJobColumns();
  const now = Math.floor(Date.now() / 1000);
  const result = await execute(
    `UPDATE cloned_voices SET deleted_at = ?
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [now, cloneId, userId]
  );
  return result.rowsAffected > 0;
}
