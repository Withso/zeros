import {
  CLOUD_REPLAY_EVENT_TYPES,
  CloudEventReplayResultSchema,
  type CloudEventCursor,
} from "@zeros/protocol/cloud-events";
import type { RuntimeClient } from "./ws-client";
import type { BridgeMessage } from "./messages";

/** Per-engine cursor. Live frames and durable replay enter the same ordered
 * subscriptions, so a reconnect cannot duplicate tool rows or lose a Stop. */
export class CloudEventReader {
  private cursor: CloudEventCursor | null = null;
  private buffered = new Map<number, BridgeMessage>();
  private listeners = new Map<string, Set<(message: BridgeMessage) => void>>();
  private off: Array<() => void> = [];
  private replaying = false;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly client: RuntimeClient,
    private readonly refreshSnapshot: () => void = () => {},
  ) {
    for (const type of CLOUD_REPLAY_EVENT_TYPES)
      this.off.push(client.on(type, (message) => this.receive(message)));
    this.off.push(
      client.onStatusChange((status) => {
        if (status === "connected" && this.cursor) void this.replay();
      }),
    );
  }
  on(type: string, listener: (message: BridgeMessage) => void): () => void {
    if (!CLOUD_REPLAY_EVENT_TYPES.has(type))
      return this.client.on(type, listener);
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(type, callbacks);
    return () => {
      callbacks.delete(listener);
    };
  }
  private emit(message: BridgeMessage): void {
    for (const listener of this.listeners.get(message.type) ?? [])
      listener(message);
  }
  private resnapshot(): void {
    this.buffered.clear();
    this.cursor = null;
    this.refreshSnapshot();
    this.emit({
      type: "DB_CHANGED",
      kinds: ["chats", "messages", "files", "git"],
    } as BridgeMessage);
  }
  private receive(message: BridgeMessage): void {
    if (this.closed) return;
    const cursor = message.cloudStream;
    if (!cursor) {
      this.emit(message);
      return;
    }
    if (this.cursor && cursor.streamId !== this.cursor.streamId)
      this.resnapshot();
    this.cursor ??= {
      streamId: cursor.streamId,
      sequence: cursor.sequence - 1,
    };
    if (cursor.sequence <= this.cursor.sequence) return;
    if (cursor.requiresSnapshot || this.buffered.size >= 512) {
      this.resnapshot();
      this.cursor = { streamId: cursor.streamId, sequence: cursor.sequence };
      return;
    }
    this.buffered.set(cursor.sequence, message);
    while (this.buffered.has(this.cursor.sequence + 1)) {
      const next = this.buffered.get(++this.cursor.sequence)!;
      this.buffered.delete(this.cursor.sequence);
      this.emit(next);
    }
    if (this.buffered.size) void this.replay();
  }
  private async replay(): Promise<void> {
    if (this.closed || this.replaying || !this.cursor) return;
    this.replaying = true;
    try {
      for (let pages = 0; pages < 64 && this.cursor && !this.closed; pages++) {
        const cursor = { ...this.cursor };
        const response = await this.client.request(
          {
            type: "WORKSPACE_REQUEST",
            op: "cloudEvents.request",
            params: { request: { kind: "replay", cursor } },
          },
          30_000,
        );
        if (this.closed) return;
        if (response.type === "WORKSPACE_ERROR") {
          if (
            [
              "event_stream_changed",
              "event_snapshot_required",
              "event_cursor_expired",
              "event_conflict",
            ].includes(response.code)
          ) {
            this.resnapshot();
            return;
          }
          throw new Error("Cloud event replay unavailable");
        }
        const result = CloudEventReplayResultSchema.parse(
          (response as unknown as { result: unknown }).result,
        );
        if (!this.cursor || this.cursor.streamId !== cursor.streamId) return;
        if (
          result.streamId !== cursor.streamId ||
          result.events.some(
            (entry, i) => entry.sequence !== cursor.sequence + i + 1,
          )
        ) {
          this.resnapshot();
          return;
        }
        for (const entry of result.events)
          this.receive(entry.frame as unknown as BridgeMessage);
        if (result.cursor >= result.head) return;
        if (this.cursor.sequence <= cursor.sequence) {
          this.resnapshot();
          return;
        }
      }
      this.resnapshot();
    } catch {
      if (!this.closed && !this.retry)
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.replay();
        }, 2000);
    } finally {
      this.replaying = false;
    }
  }
  dispose(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    for (const off of this.off) off();
    this.listeners.clear();
    this.buffered.clear();
  }
}
