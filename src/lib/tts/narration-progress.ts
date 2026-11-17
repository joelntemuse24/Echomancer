/**
 * Take-home progress as a share of sections that are actually stored.
 *
 * A book that has just published its first section is that fraction of the
 * outline, not 99%. 99% is only the rounded ratio when nearly every section
 * is already in. When every section is stored the value is 100; the player
 * calls that finishing until the job itself is ready.
 */
export function narrationProgressPercent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done <= 0) {
    return 0;
  }
  if (done >= total) return 100;
  return Math.min(99, Math.max(1, Math.round((done / total) * 100)));
}
