import { CloudRuntimeAccessError } from "./cloud-runtime-access-error";

const MAX_COMMANDS = 16;
const MAX_QUEUED_BYTES = 1024 * 1024;
type Options = { prepare(command: string): Promise<string>; send(envelope: string): void;
  cancel(requestId: string): void; assertCurrent(): void };
type Pending = { text: string; requestId: string; eligible: boolean; bytes: number; signal?: AbortSignal;
  onAbort?: () => void; releasePreparationWait?: () => void; settled: boolean; resolve(): void; reject(error: unknown): void };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const cancelled = () => new DOMException("Command send cancelled", "AbortError");

/** Only negotiated SDK command traffic enters this queue. PTY, files and all
 * ordinary socket frames keep their direct transport. Proof-bearing envelopes
 * are transient opaque bytes: forward once, never parse, cache or retry them. */
export class CloudSdkCommandSender {
  private readonly queue: Pending[] = [];
  private active?: Pending;
  private preparing?: Pending;
  private draining = false;
  private closed = false;

  constructor(private readonly options: Options) {}

  send(text: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.assertCurrent(); signal?.throwIfAborted();
        const frame = record(JSON.parse(text)), params = record(frame.params), request = record(params.request);
        if (Object.hasOwn(params, "acceptedWorkProof")) throw new CloudRuntimeAccessError({ code: "invalid_input", status: 422 });
        const action = record(record(request.mutation).action);
        const eligible = frame.type === "WORKSPACE_REQUEST" && frame.op === "cloudCommands.request" && params.cloudLocalCommandsVersion === 1 &&
          request.kind === "mutate" && action.kind === "enqueue" && !Object.hasOwn(record(action.payload), "operation");
        if (!eligible && !this.active && !this.queue.length) { this.options.send(text); resolve(); return; }
        const bytes = new TextEncoder().encode(text).byteLength;
        const cancelledPreparation = this.preparing !== this.active ? this.preparing : undefined;
        const heldBytes = (this.active?.bytes ?? 0) + (cancelledPreparation?.bytes ?? 0) + this.queue.reduce((sum, item) => sum + item.bytes, 0);
        if (this.queue.length + Number(Boolean(this.active)) + Number(Boolean(cancelledPreparation)) >= MAX_COMMANDS || heldBytes + bytes > MAX_QUEUED_BYTES)
          throw new CloudRuntimeAccessError({ code: "rate_limited", status: 429 });
        if (typeof frame.id !== "string") throw new CloudRuntimeAccessError({ code: "invalid_input", status: 422 });
        const pending: Pending = { text, requestId: frame.id, eligible, bytes, signal, resolve, reject, settled: false };
        pending.onAbort = () => {
          if (this.active === pending) this.cancelNative(pending);
          else { const index = this.queue.indexOf(pending); if (index >= 0) this.queue.splice(index, 1); }
          this.finish(pending, { error: cancelled() });
        };
        signal?.addEventListener("abort", pending.onAbort, { once: true });
        this.queue.push(pending); void this.drain();
      } catch (error) { reject(error); }
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length) {
        const pending = this.active = this.queue.shift()!;
        try {
          this.assertCurrent(); pending.signal?.throwIfAborted();
          const envelope = pending.eligible ? await this.prepare(pending) : pending.text;
          if (pending.settled) continue;
          this.assertCurrent(); pending.signal?.throwIfAborted();
          // Sending is synchronous. An immediate correlated response may
          // end the RPC while send() is still on the stack.
          this.detachAbort(pending);
          this.options.send(envelope); this.finish(pending);
        } catch (error) { this.finish(pending, { error }); }
        finally { this.active = undefined; }
      }
    } finally { this.draining = false; }
  }

  private prepare(pending: Pending): Promise<string> {
    if (this.preparing) throw new CloudRuntimeAccessError({ code: "rate_limited", status: 429 });
    this.preparing = pending;
    const cancelledWait = new Promise<never>((_, reject) => { pending.releasePreparationWait = () => reject(cancelled()); });
    let preparation: Promise<string>;
    try { preparation = this.options.prepare(pending.text); }
    catch (error) { preparation = Promise.reject(error); }
    // Cancellation releases the drain even if signing never settles. Keep its
    // slot and payload budget until settlement so cancellation churn cannot
    // accumulate native work or callbacks; controls can still use the socket.
    return Promise.race([preparation.finally(() => {
      if (this.preparing === pending) this.preparing = undefined;
    }), cancelledWait]);
  }

  private finish(pending: Pending, failure?: { error: unknown }): void {
    if (pending.settled) return;
    pending.settled = true;
    this.detachAbort(pending);
    pending.releasePreparationWait?.(); pending.releasePreparationWait = undefined;
    if (failure) pending.reject(failure.error instanceof Error ? failure.error : new CloudRuntimeAccessError(failure.error));
    else pending.resolve();
  }
  private detachAbort(pending: Pending): void {
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.onAbort = undefined;
  }
  private cancelNative(pending: Pending): void {
    if (!pending.eligible || pending.settled) return;
    try { this.options.cancel(pending.requestId); } catch { /* local cancellation remains authoritative */ }
  }
  private assertCurrent(): void { if (this.closed) throw cancelled(); this.options.assertCurrent(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.active) { this.cancelNative(this.active); this.finish(this.active, { error: cancelled() }); }
    for (const pending of this.queue.splice(0)) this.finish(pending, { error: cancelled() });
  }
}
