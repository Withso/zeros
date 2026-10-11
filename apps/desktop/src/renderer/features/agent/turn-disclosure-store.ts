import type { AgentMessage } from "./use-agent-session";

export type DisclosureValue = boolean | string | null;

/** One mounted turn owns these choices, including its nested Agent feeds.
 * Only scalar disclosure state survives regrouping; no hidden DOM or work is
 * retained. Entries are bounded by the turn's current message tree. */
export function createTurnDisclosureStore() {
  const values = new Map<string, Map<string, DisclosureValue>>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(messageId: string, disclosure: string): DisclosureValue | undefined {
      return values.get(messageId)?.get(disclosure);
    },
    set(messageId: string, disclosure: string, value: DisclosureValue) {
      let entry = values.get(messageId);
      if (entry?.get(disclosure) === value) return;
      if (!entry) values.set(messageId, (entry = new Map()));
      entry.set(disclosure, value);
      listeners.get(messageId)?.forEach((listener) => listener());
    },
    subscribe(messageId: string, listener: () => void) {
      let entry = listeners.get(messageId);
      if (!entry) listeners.set(messageId, (entry = new Set()));
      entry.add(listener);
      return () => {
        entry.delete(listener);
        if (!entry.size) listeners.delete(messageId);
      };
    },
    retain(events: readonly AgentMessage[], children: ReadonlyMap<string, AgentMessage[]>) {
      if (!values.size) return;
      const retained = new Set<string>();
      const pending = [events];
      for (let index = 0; index < pending.length; index++) {
        for (const event of pending[index]) {
          if (retained.has(event.id)) continue;
          retained.add(event.id);
          if (event.kind === "tool") {
            const nested = children.get(event.toolCallId);
            if (nested) pending.push(nested);
          }
        }
      }
      for (const messageId of values.keys()) {
        if (retained.has(messageId)) continue;
        values.delete(messageId);
        listeners.get(messageId)?.forEach((listener) => listener());
      }
    },
  };
}
