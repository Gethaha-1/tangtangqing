/**
 * Re-authorizes the exact row immediately before it is serialized.
 *
 * Optimistic writes may fail after a concurrent move to another vehicle. The
 * caller must not expose that re-read row using authorization from an older
 * snapshot.
 */
export async function authorizeBeforeExpose<T, R>(
  record: T | null,
  authorize: (record: T) => Promise<void>,
  serialize: (record: T | null) => R,
): Promise<R> {
  if (record !== null) await authorize(record);
  return serialize(record);
}
