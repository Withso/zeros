import {
  CLOUD_REPLAY_EVENT_TYPES,
  CloudEventCursorSchema,
  CloudEventReplayResultSchema,
  type CloudEventCursor,
} from "@zeros/protocol/cloud-events";
import type { RuntimeClient } from "./ws-client";
import type { BridgeMessage } from "./messages";
import { record } from "./cloud-runtime-wire";

export type CloudSnapshotInstallation = {
  current(): boolean;
  install(cursor: unknown, owner: { conversationId: string; executionId?: string }): void;
  finish(): void;
};
const orderedTypes = new Set([...CLOUD_REPLAY_EVENT_TYPES, "AGENT_SESSION_CREATED", "AGENT_SESSION_LOADED"]);

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
  private epoch = 0;
  private snapshots = new Set<symbol>();
  private snapshotBase: CloudEventCursor | null = null;
  private snapshotFloors = new Map<string, { cursor: CloudEventCursor; executionId?: string }>();

  constructor(
    private readonly client: RuntimeClient,
    private readonly refreshSnapshot: () => void = () => {},
  ) {
    for (const type of orderedTypes)
      this.off.push(client.on(type, (message) => this.receive(message)));
    this.off.push(
      client.onStatusChange((status) => {
        if (status !== "connected") { this.retireSnapshots(); this.buffered.clear(); }
        // All connected listeners may begin restoring attachments first.
        else {
          const epoch = this.epoch;
          void Promise.resolve().then(() => {
            if (this.closed || epoch !== this.epoch) return;
            this.emit({ type: "DB_CHANGED", kinds: ["files", "git"] } as BridgeMessage);
            void this.replay();
          });
        }
      }),
    );
  }
  on(type: string, listener: (message: BridgeMessage) => void): () => void {
    if (!orderedTypes.has(type))
      return this.client.on(type, listener);
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(type, callbacks);
    return () => {
      callbacks.delete(listener);
    };
  }
  private emit(message: BridgeMessage): void {
    const frame = record(message);
    const execution = frame.executionId ?? frame.sessionId ?? record(frame.notification).sessionId ?? record(frame.request).sessionId;
    if (message.cloudStream && message.type !== "DB_CHANGED") {
      for (const [conversationId, floor] of this.snapshotFloors) {
        if ((frame.chatId === conversationId || (floor.executionId && execution === floor.executionId)) &&
            message.cloudStream.streamId === floor.cursor.streamId && message.cloudStream.sequence <= floor.cursor.sequence) return;
      }
    }
    for (const listener of this.listeners.get(message.type) ?? [])
      listener(message);
  }
  private resnapshot(): void {
    this.retireSnapshots();
    this.buffered.clear();
    this.cursor = null;
    this.snapshotFloors.clear();
    this.refreshSnapshot();
    this.emit({
      type: "DB_CHANGED",
      kinds: ["chats", "messages", "files", "git"],
    } as BridgeMessage);
  }
  private retireSnapshots(): void {
    this.epoch++;
    this.snapshots.clear();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  /** Hold fan-out from before the state read until the caller has installed
   * and published that snapshot. A conversation snapshot never advances past
   * another conversation's unread events in the shared engine journal. */
  beginSnapshot(): CloudSnapshotInstallation {
    if (!this.snapshots.size) this.snapshotBase = this.cursor;
    const token = Symbol(), epoch = this.epoch;
    this.snapshots.add(token);
    const current = () => !this.closed && epoch === this.epoch && this.snapshots.has(token);
    return {
      current,
      install: (raw, owner) => {
        if (!current()) throw new Error("Cloud snapshot retired");
        const cursor = CloudEventCursorSchema.parse(raw);
        const bufferedStream = this.buffered.values().next().value?.cloudStream?.streamId;
        if (bufferedStream && bufferedStream !== cursor.streamId) throw new Error("Cloud snapshot stream changed");
        if (this.cursor && this.cursor.streamId !== cursor.streamId) {
          this.cursor = null; this.snapshotBase = null; this.snapshotFloors.clear();
        }
        if (this.snapshotBase && cursor.sequence < this.snapshotBase.sequence) throw new Error("Cloud snapshot cursor regressed");
        if (!this.snapshotBase)
          this.cursor = { ...cursor, sequence: Math.min(cursor.sequence, this.cursor?.sequence ?? cursor.sequence) };
        if (!this.snapshotFloors.has(owner.conversationId) && this.snapshotFloors.size >= 256)
          throw new Error("Cloud snapshot attachment limit reached");
        this.snapshotFloors.set(owner.conversationId, { cursor, executionId: owner.executionId });
      },
      finish: () => {
        if (!current()) return;
        this.snapshots.delete(token);
        if (this.snapshots.size) return;
        this.drain();
        // A snapshot can finish without any subsequent live frame. Replay
        // from its cursor to recover a final event lost during the read.
        void this.replay();
      },
    };
  }
  private receive(message: BridgeMessage): void {
    if (this.closed) return;
    const cursor = message.cloudStream;
    if (!cursor) {
      // Older engines do not sequence admission metadata. If it crosses a
      // state read, only a fresh snapshot can establish which came first.
      if (this.snapshots.size) this.resnapshot();
      else this.emit(message);
      return;
    }
    const stream = this.cursor?.streamId ?? this.buffered.values().next().value?.cloudStream?.streamId;
    if (stream && cursor.streamId !== stream)
      this.resnapshot();
    if (this.cursor && cursor.sequence <= this.cursor.sequence) return;
    if (cursor.requiresSnapshot || this.buffered.size >= 512) {
      this.resnapshot();
      this.cursor = { streamId: cursor.streamId, sequence: cursor.sequence };
      return;
    }
    this.buffered.set(cursor.sequence, message);
    this.drain();
  }
  private drain(): void {
    if (this.closed || this.snapshots.size) return;
    const first = this.buffered.values().next().value?.cloudStream;
    if (!this.cursor && first) this.cursor = { streamId: first.streamId, sequence: Math.min(...this.buffered.keys()) - 1 };
    if (!this.cursor) return;
    for (const sequence of this.buffered.keys()) if (sequence <= this.cursor.sequence) this.buffered.delete(sequence);
    while (!this.snapshots.size && this.buffered.has(this.cursor.sequence + 1)) {
      const next = this.buffered.get(++this.cursor.sequence)!;
      this.buffered.delete(this.cursor.sequence);
      this.emit(next);
    }
    if (this.buffered.size) void this.replay();
  }
  private async replay(): Promise<void> {
    if (this.closed || this.replaying || this.snapshots.size || !this.cursor) return;
    this.replaying = true;
    const epoch = this.epoch;
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
        if (this.closed || this.snapshots.size) return;
        if (epoch !== this.epoch) return;
        if (!this.cursor) return;
        // A replacement engine can send its first frames while the previous
        // engine's request is still settling. Its late response has no authority
        // over the new cursor; drain the new stream instead.
        if (this.cursor.streamId !== cursor.streamId) continue;
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
        // A second gap may have arrived while this page was in flight. Its
        // head describes the earlier read, not everything we have since seen
        // live. Keep draining without waiting for another live frame (there
        // may be none after the final answer/turn marker).
        if (result.cursor >= result.head && this.buffered.size === 0) return;
        if (this.cursor.sequence <= cursor.sequence) {
          this.resnapshot();
          return;
        }
      }
      this.resnapshot();
    } catch {
      if (!this.closed && epoch === this.epoch && !this.retry)
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.replay();
        }, 2000);
    } finally {
      this.replaying = false;
      if (epoch !== this.epoch && this.cursor) void this.replay();
    }
  }
  dispose(): void {
    this.closed = true;
    this.retireSnapshots();
    this.snapshotFloors.clear();
    if (this.retry) clearTimeout(this.retry);
    for (const off of this.off) off();
    this.listeners.clear();
    this.buffered.clear();
  }
}
