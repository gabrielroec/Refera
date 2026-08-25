/**
 * Bounded-concurrency map. No dependency: a dozen lines beat pulling p-limit
 * into a worker bundle.
 *
 * Results keep input order; a rejected item rejects the whole call, so wrap
 * per-item work in its own try/catch when partial failure is acceptable.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker,
  );
  await Promise.all(workers);
  return results;
}
