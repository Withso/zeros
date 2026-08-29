import type { PreparedBoundary } from "./types";

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;
const STEADY_RETRY_DELAY_MS = 300_000;

/**
 * Keeps a failed, idempotent boundary proof fail-closed while retrying it in
 * the background. `promise` always names the current attempt: lifecycle gates
 * still reject an observed failure immediately, while a later gate can await
 * an in-flight retry or see that the record has been removed after proof.
 */
export class RetriableBoundaryRetirement {
  private currentAttempt: Promise<void> = Promise.resolve();
  private started = false;
  private failureCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly boundary: Pick<PreparedBoundary, "stopAndProve">,
    private readonly callbacks: {
      onFailure(error: unknown, attempt: number): void;
      onProven(recovered: boolean): void;
    },
  ) {}

  get promise(): Promise<void> {
    return this.currentAttempt;
  }

  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.runAttempt();
    }
    return this.currentAttempt;
  }

  private runAttempt(): void {
    const attemptNumber = this.failureCount + 1;
    const attempt = Promise.resolve().then(() => this.boundary.stopAndProve());
    this.currentAttempt = attempt;
    void attempt.then(
      () => {
        this.retryTimer = null;
        this.callbacks.onProven(this.failureCount > 0);
      },
      (error) => {
        this.failureCount += 1;
        this.callbacks.onFailure(error, attemptNumber);
        const delay =
          RETRY_DELAYS_MS[this.failureCount - 1] ?? STEADY_RETRY_DELAY_MS;
        const timer = setTimeout(() => {
          if (this.retryTimer !== timer) return;
          this.retryTimer = null;
          this.runAttempt();
        }, delay);
        timer.unref?.();
        this.retryTimer = timer;
      },
    );
  }
}
