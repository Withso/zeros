import type { SendQueue } from "./send-queue";

/** Capability upgrades transfer only unsubmitted FIFO entries. Ownership stays
 * in the legacy queue until the strict journal transaction commits. A steering
 * attempt with an unknown receipt cannot be silently sent through a new path. */
export class CloudPromptHandoff {
  private readonly flights = new Map<string, Promise<void>>();
  run<T extends { bubbleId: string; steerRequest?: object }>(input: {
    chatId: string; queue: SendQueue<T>; cancelReadiness(): void;
    save(entry: T): Promise<void>; remove(entry: T): void;
  }): Promise<void> {
    const { chatId, queue } = input, existing = this.flights.get(chatId);
    if (existing) return existing;
    const entries = [...(queue.get(chatId) ?? [])];
    if (!entries.length) return Promise.resolve();
    if (entries.some(entry => entry.steerRequest || queue.isSending(chatId, entry.bubbleId)))
      return Promise.reject(new Error("Check the previous delivery before sending again."));
    queue.pause(chatId); input.cancelReadiness();
    for (const entry of entries) queue.claim(chatId, entry.bubbleId);
    const flight = (async () => {
      try {
        for (const entry of entries) {
          await input.save(entry);
          queue.set(chatId, (queue.get(chatId) ?? []).filter(value => value !== entry));
          input.remove(entry);
        }
        if (!queue.get(chatId)?.length) queue.delete(chatId);
      } finally { for (const entry of entries) queue.release(chatId, entry.bubbleId); }
    })().finally(() => { if (this.flights.get(chatId) === flight) this.flights.delete(chatId); });
    this.flights.set(chatId, flight); return flight;
  }
}
