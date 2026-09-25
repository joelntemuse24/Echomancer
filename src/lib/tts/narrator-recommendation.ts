/**
 * Narrator suggestion from listen-prep chunk notes.
 *
 * Articles, biography, and general nonfiction are Andrew on standard
 * delivery. History is Randolph on standard delivery. A novel may be any
 * stock voice, standard or expressive, depending on the kind the notes name.
 * Clones are never suggested. The picker can ignore the suggestion.
 */

import { downloadFile, uploadFile } from "@/lib/storage";
import {
  readListenPrepCache,
  scheduleListenPrepUnlessFresh,
} from "@/lib/tts/listen-prep-cache";
import {
  coerceNarratorRecommendation,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";

export {
  coerceNarratorRecommendation,
  narratorMarksVoice,
  withNarratorRecommendation,
  type NarratorCatalogVoiceId,
  type NarratorKind,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";

export const NARRATOR_JSON_NAME = "narrator.json";

export type NarratorFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export function narratorObjectKey(uploadId: string): string {
  return `pdfs/${uploadId}/${NARRATOR_JSON_NAME}`;
}

export function contentObjectKey(uploadId: string): string {
  return `pdfs/${uploadId}/content.txt`;
}

export function parseNarratorRecommendation(
  raw: string
): NarratorRecommendation | null {
  try {
    return coerceNarratorRecommendation(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readCachedNarrator(
  uploadId: string
): Promise<NarratorRecommendation | null> {
  try {
    const buf = await downloadFile(narratorObjectKey(uploadId));
    return parseNarratorRecommendation(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Cached suggestion from the listen-prep notes. Does not send the book
 * again, and does not start a second cleanup when one is already stored.
 * A miss schedules cleanup and returns null so the picker can show now.
 */
export async function loadNarratorRecommendation(
  uploadId: string,
  fileName?: string | null,
  opts?: { fetch?: NarratorFetch }
): Promise<NarratorRecommendation | null> {
  void fileName;
  void opts;
  const cached = await readCachedNarrator(uploadId);
  if (cached) return cached;
  let book = "";
  try {
    book = (await downloadFile(contentObjectKey(uploadId))).toString("utf8");
  } catch {
    return null;
  }
  const prep = await readListenPrepCache(uploadId, book);
  if (!prep) {
    await scheduleListenPrepUnlessFresh(uploadId, book);
    return null;
  }
  if (!prep.narrator) return null;
  try {
    await uploadFile(
      `pdfs/${uploadId}`,
      NARRATOR_JSON_NAME,
      Buffer.from(JSON.stringify(prep.narrator), "utf8"),
      "application/json"
    );
  } catch (err) {
    console.warn(
      "[narrator] cache write failed:",
      err instanceof Error ? err.message : err
    );
  }
  return prep.narrator;
}
