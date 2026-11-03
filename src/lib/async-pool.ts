/**
 * Bounded-concurrency async map.
 *
 * Five modules had their own copy of this loop (`listen-prep`, `chapter-ai`,
 * `concat-audio`, `section-master`, `stream-finalize`). They differ only in
 * whether the callback is handed the index, so this one always passes it.
 *
 * Order of results matches input order regardless of completion order. A
 * rejection propagates after in-flight work settles, exactly as
 * `Promise.all` over the previous workers did.
 */

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  if (items.length === 0) return out;
  let next = 0;
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}
