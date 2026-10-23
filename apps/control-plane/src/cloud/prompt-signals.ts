import { HttpError } from "../authz.js";

/** Notifications are hints, not a queue. Register before the database read;
 * timeout/reconnect always re-read the outbox. No database connection is held
 * while a worker waits, and a hint never creates or wakes a VM. */
export class CloudV2PromptSignals {
  private readonly waiters = new Map<string, Set<() => void>>();
  private count = 0;
  wait(workspaceId: string, milliseconds: number, signal: AbortSignal) {
    const listeners = this.waiters.get(workspaceId) ?? new Set<() => void>();
    if (this.count >= 1024 || listeners.size >= 8) throw new HttpError(429, "prompt_polls_full", "Too many delivery polls");
    let resolve!: () => void, settled = false;
    const wait = new Promise<void>(done => { resolve = done; });
    const dispose = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", dispose);
      listeners.delete(dispose); this.count--;
      if (!listeners.size) this.waiters.delete(workspaceId);
      resolve();
    };
    const timer = setTimeout(dispose, Math.min(25_000, Math.max(0, milliseconds))); timer.unref();
    listeners.add(dispose); this.waiters.set(workspaceId, listeners); this.count++;
    if (signal.aborted) dispose(); else signal.addEventListener("abort", dispose, { once: true });
    return { wait, dispose };
  }
  wake(workspaceId: string): void { for (const wake of [...this.waiters.get(workspaceId) ?? []]) wake(); }
  wakeAll(): void { for (const id of [...this.waiters.keys()]) this.wake(id); }
}
