const WAIT_LIMIT_MS = 3 * 60_000;
const RETRY_MS = 2_000;
const SAFETY_LIMIT_MS = 15 * 60_000;

/** Stored on the undispatched FIFO row so closed readiness refusals retain
 * their elapsed ready/busy budget across replacement connections and retries. */
export interface CloudSendWaitBudget { elapsedMs: number; readySince?: number }

export class CloudSendWaitError extends Error {
  constructor(message: string, readonly reason?: AgentSendFailureReason) { super(message); }
}

/** Readiness only: retries never contain a prompt or replay a dispatched turn.
 * The existing FIFO keeps the editable payload and stable message identity. */
export class CloudSendWait {
  private readonly flights = new Map<string, { controller: AbortController; current(): boolean }>();

  start(chatId: string, options: {
    current(): boolean;
    attempt(signal: AbortSignal): Promise<boolean>;
    terminal(error: unknown): boolean;
    cancelPreparation(): void;
    ready(): void;
    failed(error: unknown): void;
    timeoutMs?: number;
    readiness?(): boolean;
    observe?(changed: () => void): () => void;
    budget?: CloudSendWaitBudget;
    safetyTimeoutMs?: number;
  }): void {
    const previous = this.flights.get(chatId);
    if (previous && !previous.controller.signal.aborted && previous.current()) return;
    this.cancel(chatId);
    const controller = new AbortController();
    const flight = { controller, current: options.current };
    this.flights.set(chatId, flight);
    const owns = () => !controller.signal.aborted && this.flights.get(chatId) === flight && options.current();
    const fail = (error: unknown) => {
      if (!owns()) return;
      controller.abort(); this.flights.delete(chatId); options.cancelPreparation(); options.failed(error);
    };
    const timeoutError = () => new CloudSendWaitError(
      "The agent did not become ready within three minutes. Your messages are still queued. Try again.",
      "queued_timeout",
    );
    const budget = options.budget ?? { elapsedMs: Math.max(0, WAIT_LIMIT_MS - (options.timeoutMs ?? WAIT_LIMIT_MS)) };
    const safetyAt = performance.now() + Math.min(options.safetyTimeoutMs ?? SAFETY_LIMIT_MS, SAFETY_LIMIT_MS);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let off = () => {};
    const cleanup = () => { clearTimeout(deadline); off(); };
    controller.signal.addEventListener("abort", cleanup, { once: true });
    const progress = () => {
      clearTimeout(deadline);
      if (!owns()) { controller.abort(); return; }
      const now = performance.now();
      try {
        // Lifecycle time does not spend the agent budget. Observe transitions
        // even while prepare/admission is hung, and surface terminal docs now.
        const ready = options.readiness?.() ?? true;
        if (ready) budget.readySince ??= now;
        else if (budget.readySince !== undefined) {
          budget.elapsedMs += now - budget.readySince; budget.readySince = undefined;
        }
        const remaining = WAIT_LIMIT_MS - budget.elapsedMs - (budget.readySince === undefined ? 0 : now - budget.readySince);
        if (ready && remaining <= 0) { fail(timeoutError()); return; }
        if (now >= safetyAt) {
          fail(new CloudSendWaitError("The workspace is still starting after fifteen minutes. Your messages are still queued. Try again.", "queued_timeout")); return;
        }
        deadline = setTimeout(progress, Math.min(1_000, safetyAt - now, ready ? remaining : Infinity));
      } catch (error) { if (options.terminal(error)) fail(error); else deadline = setTimeout(progress, 1_000); }
    };
    off = options.observe?.(progress) ?? off;
    progress();
    if (!owns()) return;
    void (async () => {
      try {
        while (owns()) {
          try {
            if (await options.attempt(controller.signal)) {
              if (owns()) options.ready();
              return;
            }
          } catch (error) {
            if (!owns()) return;
            if (options.terminal(error)) { fail(error); return; }
          }
          if (!owns()) return;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, RETRY_MS);
            controller.signal.addEventListener("abort", done, { once: true });
          });
        }
      } finally {
        cleanup(); controller.signal.removeEventListener("abort", cleanup);
        if (this.flights.get(chatId) === flight) this.flights.delete(chatId);
      }
    })();
  }

  cancel(chatId: string): void {
    this.flights.get(chatId)?.controller.abort(); this.flights.delete(chatId);
  }
  clear(): void { for (const chatId of this.flights.keys()) this.cancel(chatId); }
}
import type { AgentSendFailureReason } from "./agent-send-failure-toast";
