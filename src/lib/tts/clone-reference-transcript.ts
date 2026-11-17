/**
 * Fill an empty clone reference transcript from the existing caption path.
 * A transcript that is already stored is left alone. A miss stays empty
 * and does not block the book.
 */

import { execute } from "@/lib/turso";
import { transcribeCloneReference } from "@/lib/tts/transcript-qa";

export async function ensureCloneReferenceTranscript(input: {
  cloneId: string;
  audio: Buffer;
}): Promise<string> {
  if (!input.cloneId || input.audio.length === 0) return "";
  try {
    const result = await transcribeCloneReference(input.audio, "audio/wav");
    const text = (result.text ?? "").trim();
    if (!text) return "";
    await execute(
      `UPDATE cloned_voices
       SET reference_transcript = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (reference_transcript IS NULL OR length(trim(reference_transcript)) = 0)`,
      [text.slice(0, 4000), input.cloneId]
    );
    return text.slice(0, 4000);
  } catch (err) {
    console.warn(
      "[clone] reference transcript was not saved:",
      err instanceof Error ? err.message : err
    );
    return "";
  }
}
