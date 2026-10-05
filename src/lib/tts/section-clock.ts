/**
 * Section starts on the finished file's clock.
 *
 * Per-section frame durations still overshoot `full.mp3` by the crossfade
 * overlap and any header frame the join did not keep. Scaling the cumulative
 * starts by the measured file duration makes the last section end on that
 * file. A stored `section-starts.json` from finalize is already that clock
 * when its total matches the file.
 */

export type SectionClock = {
  sectionStarts: number[];
  totalSeconds: number;
};

/** Absolute slack. The bitrate-sum error on a long book is minutes, not seconds. */
export const STORED_STARTS_SLACK_SEC = 3;

export function scaleSectionStarts(durations: number[], fullSeconds: number): SectionClock {
  const safe = durations.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const sum = safe.reduce((total, value) => total + value, 0);
  const total = fullSeconds > 0 ? fullSeconds : sum;
  const scale = sum > 0 && fullSeconds > 0 ? fullSeconds / sum : 1;
  const sectionStarts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < safe.length; i++) {
    sectionStarts[i] = cursor;
    cursor += safe[i]! * scale;
  }
  return { sectionStarts, totalSeconds: total };
}

export function storedStartsMatchFile(stored: SectionClock, fullSeconds: number): boolean {
  if (!(stored.totalSeconds > 0) || !(fullSeconds > 0)) return false;
  if (!stored.sectionStarts.some((start) => Number.isFinite(start))) return false;
  return Math.abs(stored.totalSeconds - fullSeconds) <= STORED_STARTS_SLACK_SEC;
}

/** Durations implied by measured starts. Holes in the array are skipped. */
export function durationsFromSectionStarts(
  sectionStarts: number[],
  totalSeconds: number
): Array<{ index: number; durationSeconds: number }> {
  const out: Array<{ index: number; durationSeconds: number }> = [];
  for (let i = 0; i < sectionStarts.length; i++) {
    const start = sectionStarts[i];
    if (typeof start !== "number" || !Number.isFinite(start)) continue;
    let next = totalSeconds;
    for (let j = i + 1; j < sectionStarts.length; j++) {
      const candidate = sectionStarts[j];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        next = candidate;
        break;
      }
    }
    const duration = next - start;
    if (duration > 0) out.push({ index: i, durationSeconds: duration });
  }
  return out;
}

/**
 * Sections in another text's coordinates.
 *
 * Packed sections carry `charStart`/`charEnd` as a running sum of their
 * trimmed bodies, with no paragraph separators. Chapter trees are anchored in
 * the full speakable text, so the two drift apart by the separators between
 * sections. Each section body appears in the text in order, so a cursor that
 * walks forward finds it exactly. A body that is not found keeps the drift of
 * the last located section, so a missing section never shifts the rest.
 */
export function relocateSections<
  T extends { charStart: number; charEnd: number; text?: string },
>(sections: T[], text: string): T[] {
  if (!text) return sections.map((section) => ({ ...section }));
  const out: T[] = [];
  let cursor = 0;
  let drift = 0;
  for (const section of sections) {
    const body = section.text ?? "";
    const found = body ? text.indexOf(body, cursor) : -1;
    if (found >= 0) {
      drift = found - section.charStart;
      const end = found + body.length;
      out.push({ ...section, charStart: found, charEnd: end });
      cursor = end;
      continue;
    }
    const length = body.length || Math.max(0, section.charEnd - section.charStart);
    const start = Math.min(text.length, Math.max(cursor, section.charStart + drift));
    out.push({ ...section, charStart: start, charEnd: Math.min(text.length, start + length) });
  }
  return out;
}
