const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export type CloneListVoice = {
  id: string;
  displayName: string;
  createdAt?: number | null;
};

function createdAtMs(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
}

function formatUtcDate(ms: number): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const month = MONTHS[date.getUTCMonth()];
  if (!month) return null;
  return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * A created date only when two clones share a name. One voice needs no date.
 */
export function duplicateCloneDateLabel(
  voices: readonly CloneListVoice[],
  voice: CloneListVoice
): string | null {
  const key = voice.displayName.trim().toLowerCase();
  if (!key || voice.createdAt == null) return null;
  const same = voices.filter(
    (item) => item.displayName.trim().toLowerCase() === key
  );
  if (same.length < 2) return null;
  const ms = createdAtMs(voice.createdAt);
  return ms == null ? null : formatUtcDate(ms);
}
