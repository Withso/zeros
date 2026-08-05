// ──────────────────────────────────────────────────────────
// InputQueue — push-based AsyncIterable for SDK streaming input
// ──────────────────────────────────────────────────────────
//
// The Claude Agent SDK's `query()` takes the prompt as an
// `AsyncIterable<SDKUserMessage>` ONCE, at creation, and keeps a single
// `claude` process alive for as long as that iterable hasn't ended. To
// drive a multi-turn conversation we need to feed user messages into
// that iterable AS THEY ARRIVE (one per `prompt()` call) rather than
// knowing them all up front.
//
// This is a single-consumer push queue: `push()` enqueues a message (or
// hands it straight to a waiting `next()`), and `end()` terminates the
// iterable so the SDK process exits cleanly. It adapts the SDK's
// single-shot `query()` API into a long-lived, stateful session.
//
// ──────────────────────────────────────────────────────────

export class InputQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;

  /** Enqueue an item. If a consumer is parked in `next()`, hand it over
   *  directly; otherwise buffer it for the next pull. No-op after end(). */
  push(item: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /** Terminate the iterable. The SDK's `query()` finishes its async
   *  generator (the `claude` process exits) once this lands. Idempotent. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Buffered messages not yet pulled by the SDK consumer. Direct hand-offs
   * to an already-waiting consumer never enter the buffer. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
      // The SDK calls return() when it stops iterating (close()/abort).
      // End the queue so a parked producer doesn't leak.
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/** Minimal externally-resolvable promise — one per in-flight turn, so
 *  `prompt()` can await the turn that the consumer loop settles when the
 *  SDK emits its `result` message. */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
