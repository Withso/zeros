import { randomUUID } from "node:crypto";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CLOUD_REPLAY_EVENT_TYPES, CloudEventAppendResultSchema, CloudEventReplayResultSchema,
  type CloudEventCursor, type CloudEventEngineRequest, type CloudStreamEvent } from "@zeros/protocol/cloud-events";
import { CloudEventRuntimeError } from "./cloud-event-client";

const MAX_FRAME = 256 * 1024, MAX_BATCH = 1000000, MAX_PENDING = 8 * 1024 * 1024;
type Pending = { event: CloudStreamEvent; bytes: number };

/** A synchronous sequence assignment precedes fan-out. Batching is independent
 * of subscribers, and a lost append acknowledgement retries the identical batch.
 * Overflow fences the producer instead of pretending a mandatory event arrived. */
export class CloudEventRuntime {
  private sequence = 0;
  private committed = 0;
  private bytes = 0;
  private pending: Pending[] = [];
  private batch: { kind: "append"; batchId: string; events: CloudStreamEvent[] } | null = null;
  private flight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 250;
  private closed = false;
  private started = false;
  private failure: CloudEventRuntimeError | null = null;
  private readonly waiters = new Set<{ target: number; resolve: () => void; reject: (error: unknown) => void }>();
  constructor(readonly streamId: string, private readonly dependencies: {
    request(request: CloudEventEngineRequest): Promise<unknown>;
    onFailure(code: string): void;
  }) {}

  start(): void { this.assertHealthy(); this.started = true; this.schedule(0); }

  capture(message: BridgeMessage): BridgeMessage {
    if (!CLOUD_REPLAY_EVENT_TYPES.has(message.type)) return message;
    this.assertHealthy();
    const next = this.sequence + 1;
    if (!Number.isSafeInteger(next)) { this.fail("event_sequence_exhausted"); throw this.failure!; }
    // Detach references because some native adapters reuse notification objects.
    const encoded = JSON.stringify({ ...message, cloudStream: { streamId: this.streamId, sequence: next } });
    const frame = JSON.parse(encoded) as BridgeMessage;
    const oversized = Buffer.byteLength(encoded) > MAX_FRAME;
    if (oversized) frame.cloudStream!.requiresSnapshot = true;
    // A large tool result already lives in the normalized transcript. Preserve
    // its live frame, and durably record an explicit resnapshot boundary rather
    // than dropping it silently or filling the incremental event journal.
    const retained: BridgeMessage = oversized ? {
      id: frame.id, timestamp: frame.timestamp, source: "engine", type: "DB_CHANGED",
      kinds: ["messages", "chats"], cloudStream: frame.cloudStream,
    } : frame;
    const bytes = Buffer.byteLength(JSON.stringify(retained));
    if (bytes + this.bytes > MAX_PENDING || this.pending.length >= 8192) {
      this.fail("event_buffer_exhausted"); throw this.failure!;
    }
    this.sequence = next; this.bytes += bytes;
    this.pending.push({ event: { sequence: next, frame: retained }, bytes });
    this.schedule(100);
    return frame;
  }

  /** The caller captures its normalized state synchronously in this callback.
   * Events emitted after it are necessarily greater than the returned cursor. */
  async snapshot<T>(captureState: () => T): Promise<{ cursor: CloudEventCursor; snapshot: T }> {
    this.assertHealthy();
    const cursor = { streamId: this.streamId, sequence: this.sequence };
    const snapshot = JSON.parse(JSON.stringify(captureState())) as T;
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) throw new CloudEventRuntimeError("event_snapshot_limit");
    await this.flush(cursor.sequence);
    return { cursor, snapshot };
  }

  async replay(cursor: CloudEventCursor) {
    this.assertHealthy();
    if (cursor.streamId !== this.streamId) throw new CloudEventRuntimeError("event_stream_changed");
    if (cursor.sequence > this.sequence) throw new CloudEventRuntimeError("event_conflict");
    await this.flush(this.sequence);
    const result = CloudEventReplayResultSchema.parse(await this.dependencies.request({ kind: "replay", streamId: this.streamId, after: cursor.sequence }));
    if (result.streamId !== this.streamId || result.head < cursor.sequence || result.cursor > result.head ||
      (result.head > cursor.sequence && result.events.length === 0) ||
      result.events.some((event, i) => event.sequence !== cursor.sequence + i + 1) ||
      result.cursor !== (result.events.at(-1)?.sequence ?? cursor.sequence)) throw new CloudEventRuntimeError("event_response_invalid");
    if (result.events.some(event => (event.frame.cloudStream as { requiresSnapshot?: unknown } | undefined)?.requiresSnapshot === true))
      throw new CloudEventRuntimeError("event_snapshot_required");
    return result;
  }

  flush(target = this.sequence): Promise<void> {
    this.assertHealthy();
    if (target <= this.committed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(waiter); reject(new CloudEventRuntimeError("event_service_unavailable")); }, 20000);
      const waiter = { target, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error: unknown) => { clearTimeout(timer); reject(error); } };
      this.waiters.add(waiter); this.schedule(0);
    });
  }

  private schedule(delay: number) {
    if (!this.started || this.closed || this.failure || this.flight) return;
    if (this.timer) { if (delay !== 0) return; clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = null; this.drain(); }, delay); this.timer.unref?.();
  }
  private drain() {
    if (this.closed || this.failure || this.flight || !this.pending.length) return;
    if (!this.batch) {
      const events: CloudStreamEvent[] = []; let size = 2;
      for (const entry of this.pending) {
        const bytes = entry.bytes + 64;
        if (events.length >= 128 || size + bytes > MAX_BATCH) break;
        events.push(entry.event); size += bytes;
      }
      this.batch = { kind: "append", batchId: randomUUID(), events };
    }
    const batch = this.batch;
    this.flight = Promise.resolve().then(() => this.dependencies.request(batch)).then(raw => {
      const response = CloudEventAppendResultSchema.parse(raw);
      if (response.streamId !== this.streamId || response.head !== batch.events.at(-1)!.sequence)
        throw new CloudEventRuntimeError("event_response_invalid");
      const removed = this.pending.splice(0, batch.events.length);
      this.bytes -= removed.reduce((sum, entry) => sum + entry.bytes, 0);
      this.committed = response.head; this.batch = null; this.retryMs = 250;
      for (const waiter of this.waiters) if (waiter.target <= this.committed) { this.waiters.delete(waiter); waiter.resolve(); }
    }).catch(error => {
      if (this.closed) return;
      if (error instanceof CloudEventRuntimeError && error.code !== "event_service_unavailable") {
        this.fail(error.code); return;
      }
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    }).finally(() => {
      this.flight = null;
      if (this.pending.length) this.schedule(this.batch ? this.retryMs : 0);
    });
  }
  private assertHealthy() { if (this.failure) throw this.failure; if (this.closed) throw new CloudEventRuntimeError("engine_authority_rejected"); }
  private fail(code: string): void {
    this.failure = new CloudEventRuntimeError(code);
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    for (const waiter of this.waiters) waiter.reject(this.failure); this.waiters.clear();
    this.dependencies.onFailure(code);
  }
  close() {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    for (const waiter of this.waiters) waiter.reject(new CloudEventRuntimeError("engine_authority_rejected")); this.waiters.clear();
  }
}
