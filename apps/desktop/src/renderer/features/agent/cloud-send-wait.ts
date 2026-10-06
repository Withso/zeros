const WAIT_LIMIT_MS = 3 * 60_000;
const RETRY_MS = 2_000;

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
    const timeoutMs = Math.min(options.timeoutMs ?? WAIT_LIMIT_MS, WAIT_LIMIT_MS);
    if (timeoutMs <= 0) { fail(timeoutError()); return; }
    const deadline = setTimeout(() => fail(timeoutError()), timeoutMs);
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
        clearTimeout(deadline);
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
