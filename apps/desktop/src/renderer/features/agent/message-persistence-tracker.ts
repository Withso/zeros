import type { AgentMessage } from "./use-agent-session";

/** Content equality for a low-frequency authoritative reconcile. Comparing
 *  only count + last id misses an edit that keeps ids stable (cross-device
 *  click-to-edit); object identity is also unusable because IPC returns fresh
 *  objects. Bridge payloads are JSON-safe by contract, so serialization gives
 *  an exact comparison over the bounded resident window. */
export function messageSnapshotsEqual(
  current: readonly AgentMessage[],
  next: readonly AgentMessage[],
): boolean {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]?.id !== next[index]?.id) return false;
    try {
      if (JSON.stringify(current[index]) !== JSON.stringify(next[index])) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Reuse unchanged durable rows from the same chat after a serialized read.
 * The incoming window still owns membership/order, including truncation.
 * Callers must finish their owner and restore-head checks before publishing. */
export function retainMessageReferences(
  current: AgentMessage[],
  next: AgentMessage[],
): AgentMessage[] {
  if (current === next || current.length === 0) return next;
  const known = new Map(current.map(message => [message.id, message]));
  const shared = next.map(message => {
    const previous = known.get(message.id);
    return previous && messageSnapshotsEqual([previous], [message]) ? previous : message;
  });
  return shared.length === current.length && shared.every((message, index) => message === current[index]) ? current : shared;
}
