import { randomUUID } from "node:crypto";
import type {
  BrowserSubscriptionProvider,
  ProviderSubscriptionStatus,
  SavedSubscriptionAccount,
} from "@zeros/protocol/provider-auth";

export interface SubscriptionAccount {
  state: "connected" | "disconnected" | "expired";
  email?: string;
  plan?: string;
  organization?: string;
  expiresAtMs?: number;
  accounts?: SavedSubscriptionAccount[];
  activeAccountId?: string;
  method?: "account" | "cli" | "apiKey";
}

export interface SubscriptionDriver {
  read(signal: AbortSignal): Promise<SubscriptionAccount>;
  /** Must settle only after its processes and callback listeners are stopped. */
  login(options: {
    signal: AbortSignal;
    onCodeRequired: (submit: (code: string) => void) => void;
  }): Promise<SubscriptionAccount>;
}

const ERRORS = {
  runtime:
    "The provider runtime is unavailable. Check its executable path or reinstall Zeros.",
  browser: "Could not open the provider sign-in page. Try connecting again.",
  failed:
    "The provider could not finish subscription sign-in. Try again or check your account access.",
  status: "Could not check the subscription connection. Try refreshing.",
} as const;
export class SubscriptionError extends Error {
  constructor(code: keyof typeof ERRORS) {
    super(ERRORS[code]);
  }
}

/** One native ceremony per provider, shared by Settings and chat. Cancellation
 * drains the old ceremony before another may write the provider's credential
 * store. It never logs out an account to simulate rolling back a browser login. */
export class ProviderSubscriptionController {
  private snapshot: ProviderSubscriptionStatus;
  private reading: {
    abort: AbortController;
    promise: Promise<ProviderSubscriptionStatus>;
  } | null = null;
  private attempt: {
    id: string;
    abort: AbortController;
    done: Promise<void>;
    submit?: (code: string) => void;
    timedOut: boolean;
  } | null = null;
  private disposed = false;
  private lastAccount: SubscriptionAccount = { state: "disconnected" };
  private recoveryAbort: AbortController | null = null;
  private changing: Promise<ProviderSubscriptionStatus> | null = null;

  constructor(
    private readonly provider: BrowserSubscriptionProvider,
    private readonly driver: SubscriptionDriver,
    private readonly publish: (status: ProviderSubscriptionStatus) => void,
  ) {
    this.snapshot = { provider, state: "disconnected", revision: 0 };
  }

  private update(
    next: Omit<ProviderSubscriptionStatus, "provider" | "revision">,
  ): ProviderSubscriptionStatus {
    this.snapshot = {
      ...next,
      provider: this.provider,
      revision: this.snapshot.revision + 1,
    };
    this.publish(this.snapshot);
    return this.snapshot;
  }

  status(): Promise<ProviderSubscriptionStatus> {
    if (this.attempt || this.changing || this.disposed)
      return Promise.resolve(this.snapshot);
    if (this.reading) return this.reading.promise;
    const revision = this.snapshot.revision;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    const promise = Promise.resolve()
      .then(() => this.driver.read(abort.signal))
      .then(
        (account) => {
          if (this.snapshot.revision === revision && !this.disposed) {
            this.lastAccount = account;
            this.update(account);
          }
          return this.snapshot;
        },
        (error: unknown) => {
          if (this.snapshot.revision === revision && !this.disposed)
            this.update({
              ...this.snapshot,
              error:
                error instanceof SubscriptionError
                  ? error.message
                  : ERRORS.status,
            });
          return this.snapshot;
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (this.reading?.promise === promise) this.reading = null;
      });
    this.reading = { abort, promise };
    return promise;
  }

  connect(): ProviderSubscriptionStatus {
    if (this.disposed || this.changing) throw new SubscriptionError("failed");
    if (this.attempt) return this.snapshot;
    const attempt = {
      id: randomUUID(),
      abort: new AbortController(),
      done: Promise.resolve(),
      timedOut: false,
      submit: undefined as ((code: string) => void) | undefined,
    };
    this.attempt = attempt;
    const started = this.update({
      ...this.lastAccount,
      state: "connecting",
      attemptId: attempt.id,
    });
    // Stop an older probe before starting a login against the same native store.
    this.reading?.abort.abort();
    const priorRead = this.reading?.promise;
    const timer = setTimeout(() => {
      attempt.timedOut = true;
      attempt.abort.abort();
    }, 5 * 60_000);
    attempt.done = Promise.resolve()
      .then(async () => {
        if (priorRead) await priorRead;
        attempt.abort.signal.throwIfAborted();
        return this.driver.login({
          signal: attempt.abort.signal,
          onCodeRequired: (submit) => {
            if (this.attempt !== attempt || attempt.abort.signal.aborted)
              return;
            attempt.submit = submit;
            this.update({
              ...this.lastAccount,
              state: "connecting",
              attemptId: attempt.id,
              canSubmitCode: true,
            });
          },
        });
      })
      .then(async (account) => {
        attempt.abort.signal.throwIfAborted();
        if (account.state !== "connected")
          throw new SubscriptionError("failed");
        this.lastAccount = account;
        this.update({ ...account, attemptId: attempt.id });
      })
      .catch(async (error: unknown) => {
        // The callback may have committed just before cancellation/failure. Report
        // the actual store and keep an existing connection on failed replacement.
        let account = this.lastAccount;
        if (!this.disposed) {
          const abort = new AbortController();
          this.recoveryAbort = abort;
          const recoveryTimer = setTimeout(() => abort.abort(), 20_000);
          try {
            account = await this.driver.read(abort.signal);
            this.lastAccount = account;
          } catch {
            /* Retain the last confirmed account when its probe fails. */
          } finally {
            clearTimeout(recoveryTimer);
            if (this.recoveryAbort === abort) this.recoveryAbort = null;
          }
        }
        this.update({
          ...account,
          attemptId: attempt.id,
          error: attempt.abort.signal.aborted
            ? attempt.timedOut
              ? "Sign-in timed out. Try connecting again."
              : "Sign-in canceled."
            : error instanceof SubscriptionError
              ? error.message
              : ERRORS.failed,
        });
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.attempt === attempt) this.attempt = null;
      });
    return started;
  }

  async cancel(attemptId: string): Promise<ProviderSubscriptionStatus> {
    const attempt = this.attempt;
    if (attempt?.id === attemptId) {
      attempt.abort.abort();
      await attempt.done;
    }
    return this.snapshot;
  }

  /** Serialize account/method mutations with native reads and ceremonies. A
   * late probe for account A cannot replace the confirmed snapshot for B. */
  change(
    action: () => Promise<SubscriptionAccount>,
  ): Promise<ProviderSubscriptionStatus> {
    const previous = this.changing;
    const work = Promise.resolve(previous)
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new SubscriptionError("failed");
        this.reading?.abort.abort();
        if (this.reading) await this.reading.promise;
        if (this.attempt) await this.cancel(this.attempt.id);
        const account = await action();
        if (this.disposed) throw new SubscriptionError("failed");
        this.lastAccount = account;
        return this.update(account);
      })
      .finally(() => {
        if (this.changing === work) this.changing = null;
      });
    this.changing = work;
    return work;
  }

  submitCode(attemptId: string, code: string): ProviderSubscriptionStatus {
    const attempt = this.attempt;
    if (
      !attempt ||
      attempt.id !== attemptId ||
      !attempt.submit ||
      attempt.abort.signal.aborted
    )
      throw new Error(
        "This sign-in no longer accepts a code. Refresh the connection.",
      );
    const submit = attempt.submit;
    attempt.submit = undefined;
    submit(code);
    return this.update({ ...this.lastAccount, state: "connecting", attemptId });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.recoveryAbort?.abort();
    this.reading?.abort.abort();
    this.attempt?.abort.abort();
    await Promise.allSettled([
      this.reading?.promise,
      this.attempt?.done,
      this.changing,
    ]);
  }
}
