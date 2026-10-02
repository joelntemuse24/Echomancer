/**
 * Read the stored chapter outline for an upload. Kept apart from
 * uploads/extract.ts so the take-home freeze path does not import the
 * extract pipeline (and its listen-prep scheduling) for one JSON read.
 */

import { downloadFile } from "@/lib/storage";
import {
  chaptersObjectKey,
  parseChaptersDocument,
  type ChaptersDocument,
} from "@/lib/book-chapters";

export async function readUploadChapters(
  uploadId: string
): Promise<ChaptersDocument | null> {
  try {
    const buf = await downloadFile(chaptersObjectKey(uploadId));
    return parseChaptersDocument(buf.toString("utf-8"));
  } catch {
    return null;
  }
}
