// Structural sharing for collections AgentChat derives from the whole message
// list on every streamed chunk. Returning the previous collection when nothing
// in it changed keeps the renderer context, and every memoized turn reading it,
// referentially stable while another message streams.

import type { AgentMessage } from "./use-agent-session";

/** The previous set when it holds exactly the same members. */
export function shareSet<T>(previous: Set<T> | undefined, next: Set<T>): Set<T> {
  if (!previous || previous.size !== next.size) return next;
  for (const value of next) if (!previous.has(value)) return next;
  return previous;
}

/** The previous map when it has the same keys and identical values. */
export function shareMap<K, V>(previous: Map<K, V> | undefined, next: Map<K, V>): Map<K, V> {
  if (!previous || previous.size !== next.size) return next;
  for (const [key, value] of next) {
    if (!previous.has(key) || previous.get(key) !== value) return next;
  }
  return previous;
}

/** Message buckets keyed by owner. An unchanged bucket keeps its previous
 *  array (same messages, same order) so per-bucket reference checks still see
 *  real changes only; the whole map is reused when no bucket changed. */
export function shareMessageBuckets(
  previous: Map<string, AgentMessage[]> | undefined,
  next: Map<string, AgentMessage[]>,
): Map<string, AgentMessage[]> {
  if (!previous) return next;
  let changed = previous.size !== next.size;
  const shared = new Map<string, AgentMessage[]>();
  for (const [key, bucket] of next) {
    const before = previous.get(key);
    if (
      before &&
      before.length === bucket.length &&
      before.every((message, index) => message === bucket[index])
    ) {
      shared.set(key, before);
    } else {
      shared.set(key, bucket);
      changed = true;
    }
  }
  return changed ? shared : previous;
}
