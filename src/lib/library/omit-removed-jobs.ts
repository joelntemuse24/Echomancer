/**
 * Drop books this page already deleted.
 * A library poll that started before the DELETE response can still return
 * the row. The successful delete wins until the server list no longer has it.
 */
export function omitRemovedJobs<T extends { id: string }>(
  jobs: readonly T[],
  removedIds: ReadonlySet<string>
): T[] {
  if (removedIds.size === 0) return jobs as T[];
  return jobs.filter((job) => !removedIds.has(job.id));
}
