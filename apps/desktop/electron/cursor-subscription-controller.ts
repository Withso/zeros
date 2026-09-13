import type { CursorSubscriptionStatus } from "@zeros/protocol/provider-auth";

export interface CursorSubscriptionCredential {
  apiKey: string;
  email?: string;
  expiresAtMs: number;
}

/** Browser authentication only: no agents, workspace settings, plugins, or
 * tools run in main. The SDK's login mint stays in the native auth boundary. */
export class CursorSubscriptionController {
  private attempt: {
    abort: AbortController;
    promise: Promise<CursorSubscriptionStatus>;
  } | null = null;
  constructor(
    private readonly deps: {
      read(): CursorSubscriptionCredential | null;
      write(value: CursorSubscriptionCredential | null): void;
      publish(): void;
      login(
        signal: AbortSignal,
      ): Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }>;
      now?: () => number;
    },
  ) {}

  status(): CursorSubscriptionStatus {
    if (this.attempt) return { state: "connecting" };
    const value = this.deps.read();
    if (!value) return { state: "disconnected" };
    return {
      state:
        value.expiresAtMs > (this.deps.now?.() ?? Date.now())
          ? "connected"
          : "expired",
      ...(value.email ? { email: value.email } : {}),
      expiresAtMs: value.expiresAtMs,
    };
  }

  connect(): Promise<CursorSubscriptionStatus> {
    if (this.attempt) return this.attempt.promise;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 180_000);
    const attempt = {
      abort,
      promise: Promise.resolve({
        state: "connecting",
      } as CursorSubscriptionStatus),
    };
    this.attempt = attempt;
    attempt.promise = Promise.resolve()
      .then(async () => {
        // Race even an SDK implementation that fails to honor AbortSignal.
        const canceled = new Promise<never>((_, reject) => {
          const rejectCanceled = () =>
            reject(new Error("Cursor sign-in was canceled or timed out."));
          if (abort.signal.aborted) rejectCanceled();
          else
            abort.signal.addEventListener("abort", rejectCanceled, {
              once: true,
            });
        });
        const result = await Promise.race([
          this.deps.login(abort.signal),
          canceled,
        ]);
        if (this.attempt !== attempt || abort.signal.aborted)
          throw new Error("Cursor sign-in was canceled.");
        if (
          !result.apiKey ||
          !Number.isFinite(result.apiKeyExpiresAtMs) ||
          result.apiKeyExpiresAtMs <= (this.deps.now?.() ?? Date.now())
        )
          throw new Error(
            "Cursor returned an expired or incomplete sign-in. Try again.",
          );
        this.deps.write({
          apiKey: result.apiKey,
          expiresAtMs: result.apiKeyExpiresAtMs,
          ...(result.email ? { email: result.email } : {}),
        });
        this.deps.publish();
        this.attempt = null;
        return this.status();
      })
      .catch(() => {
        // Provider exceptions can include authorization URLs or credentials.
        throw new Error(
          abort.signal.aborted
            ? "Cursor sign-in was canceled or timed out."
            : "Cursor sign-in could not finish. Try again in your browser.",
        );
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.attempt === attempt) this.attempt = null;
      });
    return attempt.promise;
  }

  cancel(): CursorSubscriptionStatus {
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.abort.abort();
    return this.status();
  }

  disconnect(): CursorSubscriptionStatus {
    this.cancel();
    this.deps.write(null);
    this.deps.publish();
    return this.status();
  }
}
