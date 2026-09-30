import { DevCallbackRelay, type RelayStore } from "./dev-callback-relay";
import type { GithubAppControllerDependencies, PendingConsumeResult } from "./github-app-controller";

const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
export interface GithubDevCallback {
  nonce: string;
  error?: string;
}

/** Like the WorkOS PKCE flow, a Dev browser attempt belongs to its initiating
 * main process. Closing/restarting that process expires its browser ceremony;
 * a different instance must never exchange it against another Dev database. */
export class GithubDevPendingHandoff {
  private pending: Parameters<GithubAppControllerDependencies["savePending"]>[0] | null = null;
  private stop: (() => void) | undefined;

  constructor(
    private readonly relay: GithubDevCallbackRelay,
    private readonly complete: (callback: GithubDevCallback) => void,
    private readonly now: () => number = Date.now,
  ) {}

  save(input: Parameters<GithubAppControllerDependencies["savePending"]>[0]): void {
    this.clear();
    this.pending = input;
    try {
      this.stop = this.relay.register(input.nonce, input.expiresAtMs, callback => {
        this.complete(callback);
        return true;
      });
    } catch (error) {
      this.pending = null;
      throw error;
    }
  }

  consume(nonce: string): PendingConsumeResult {
    const pending = this.pending;
    if (!pending) return { status: "missing" };
    if (pending.expiresAtMs <= this.now()) { this.clear(); return { status: "expired" }; }
    if (pending.nonce !== nonce) return { status: "mismatch" };
    this.clear();
    return { status: "consumed", preserveSelectedMethod: pending.preserveSelectedMethod, ownerSub: pending.ownerSub };
  }

  discard(nonce: string): void {
    if (this.pending?.nonce === nonce) this.clear();
  }

  clear(): void {
    this.pending = null;
    const stop = this.stop;
    this.stop = undefined;
    stop?.();
  }
}

/** Only the initiating main process exchanges the nonce with its configured
 * backend. This shared mailbox carries no sessions or GitHub credentials. */
export class GithubDevCallbackRelay extends DevCallbackRelay<GithubDevCallback> {
  constructor(store?: RelayStore, now?: () => number) {
    super({
      key: "github-app:dev-callbacks",
      validState: nonce => NONCE.test(nonce),
      state: callback => callback.nonce,
      normalize(value) {
        const input = value as { nonce?: unknown; error?: unknown } | null;
        if (!input || typeof input.nonce !== "string" || !NONCE.test(input.nonce)) return null;
        if (!input.error) return { nonce: input.nonce };
        const error = typeof input.error === "string" &&
          ["access_denied", "authorization_expired", "github_unavailable"].includes(input.error)
          ? input.error : "oauth_failed";
        return { nonce: input.nonce, error };
      },
    }, store, now);
  }
}
