// Main-process GitHub App state machine with all host dependencies injected.
//
// Keeping the orchestration pure makes the security contracts executable:
// nonce consumption precedes exchange, Auth0 subjects bind stored credentials,
// refresh rotation is single-flight + cross-process serialized, and failed
// replacement never displaces a previously working App credential.

import type {
  GithubAuthMethod,
  GithubCredential,
} from "@zeros/core/github-auth";
import {
  GITHUB_GIT_HOST,
  GITHUB_GIT_HTTP_USERNAME,
} from "@zeros/core/github-auth";

import {
  GithubAppClientError,
  type GithubAppClient,
} from "./github-app-client";

type GithubAppCredential = Extract<GithubCredential, { method: "github-app" }>;

export const GITHUB_APP_TRANSIENT_REFRESH_RETRY_MS = 30_000;

export type GithubAppConnectionErrorReason =
  | "access_denied"
  | "authorization_expired"
  | "github_unavailable"
  | "handoff_expired"
  | "invalid_callback"
  | "nonce_mismatch"
  | "not_configured"
  | "oauth_failed"
  | "signed_out"
  | "storage_failed";

export type PendingConsumeResult =
  | { status: "consumed" }
  | {
      status: "missing" | "mismatch" | "expired";
    };

export interface GithubAppControllerDependencies {
  client: Pick<
    GithubAppClient,
    "start" | "exchange" | "refresh" | "revoke" | "refreshInstallations"
  >;
  credentialStore: {
    get(method: "github-app"): Promise<GithubAppCredential | null>;
    set(method: "github-app", credential: GithubAppCredential): Promise<void>;
    clear(method: "github-app"): Promise<void>;
    getSelectedMethod(): Promise<GithubAuthMethod>;
    setSelectedMethod(method: GithubAuthMethod): Promise<void>;
  };
  compareAndSetCredential(
    expected: GithubAppCredential,
    next: GithubAppCredential | null,
  ): Promise<boolean>;
  getSession(): Promise<{ accessToken: string; sub: string } | null>;
  savePending(input: { nonce: string; expiresAtMs: number }): void;
  consumePending(nonce: string): PendingConsumeResult;
  discardPending(nonce: string): void;
  clearPending(): void;
  openExternal(url: string): Promise<void>;
  randomNonce(): string;
  withCredentialLock<T>(operation: () => Promise<T>): Promise<T>;
  afterCredentialChange(
    credential: GithubAppCredential | null,
  ): void | Promise<void>;
  /** Queue a quiet retry after a transient rotation failure. The durable pair
   * remains intact, but the engine has already refused to reuse its rejected
   * access token and therefore needs a fresh courier promptly. */
  afterTransientRefreshFailure?(retryAfterMs: number): void | Promise<void>;
  emitConnected(payload: { login: string; installationCount: number }): void;
  emitError(reason: GithubAppConnectionErrorReason): void;
  now?: () => number;
}

export class GithubAppFlowError extends Error {
  constructor(
    message: string,
    public readonly reason: GithubAppConnectionErrorReason,
    public readonly terminal = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GithubAppFlowError";
  }
}

function mappedCallbackError(
  value: string | null | undefined,
): GithubAppConnectionErrorReason | null {
  if (!value) return null;
  if (value === "access_denied") return "access_denied";
  if (value === "authorization_expired") return "authorization_expired";
  if (value === "github_unavailable") return "github_unavailable";
  return "oauth_failed";
}

function mapClientError(error: unknown): GithubAppFlowError {
  if (error instanceof GithubAppFlowError) return error;
  if (error instanceof GithubAppClientError) {
    if (error.code === "github_authorization_expired") {
      return new GithubAppFlowError(
        "The GitHub authorization expired.",
        "authorization_expired",
        true,
      );
    }
    // The control plane could not verify OUR refresh binding — the GitHub grant
    // itself may be perfectly healthy. Rotating the backend's binding key
    // produces exactly this, so treating it as terminal would delete a working
    // credential on every machine at once. Prompt a reconnect, keep the pair.
    if (error.code === "github_binding_invalid") {
      return new GithubAppFlowError(
        "This GitHub connection needs to be re-authorized.",
        "authorization_expired",
        false,
      );
    }
    if (
      error.code === "handoff_not_found" ||
      error.code === "oauth_state_expired"
    ) {
      return new GithubAppFlowError(
        "The GitHub handoff expired.",
        "handoff_expired",
      );
    }
    // A control plane that has no GitHub routes at all answers with its generic
    // 404, and one deployed without a GitHub App registration answers
    // `github_not_configured`. Both mean the same thing to the user — this build
    // cannot do App sign-in — and neither is worth retrying. Deliberately NOT
    // terminal: a rolled-back or half-configured backend must not delete an App
    // credential that still works (see refreshUnderLock).
    if (error.code === "github_not_configured" || error.status === 404) {
      return new GithubAppFlowError(
        "GitHub App sign-in isn’t available on this Zeros control plane yet. " +
          "Use gh CLI or a Personal Access Token for now.",
        "not_configured",
      );
    }
    // Never surface the control plane's own wording: it is written for
    // operators ("Not found"), and for an unexpected status it may be an
    // upstream proxy's text rather than ours. main logs the original.
    const transport = error.code === "network" || error.status >= 500;
    return new GithubAppFlowError(
      transport
        ? "Zeros couldn’t reach the GitHub connection service. Try again."
        : "GitHub couldn’t complete this connection. Start again from Settings.",
      transport ? "github_unavailable" : "oauth_failed",
      error.terminal,
    );
  }
  return new GithubAppFlowError(
    error instanceof Error ? error.message : "GitHub authorization failed.",
    "oauth_failed",
  );
}

function sameRotatingPair(
  left: GithubAppCredential,
  right: GithubAppCredential,
): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.refreshBinding === right.refreshBinding &&
    left.ownerSub === right.ownerSub
  );
}

function validNonce(value: string): boolean {
  return (
    value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export class GithubAppController {
  private readonly now: () => number;
  private refreshInFlight: Promise<GithubAppCredential | null> | null = null;
  /** Advanced by every cancel. `begin()` reaches the control plane before it has
   * anything to clear, so a cancel during those round trips has no persisted
   * state to remove — it has to be observed in memory instead. */
  private cancelEpoch = 0;

  constructor(private readonly deps: GithubAppControllerDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async begin(input: { scheme: string; installFlow: boolean }): Promise<void> {
    const epoch = this.cancelEpoch;
    const session = await this.deps.getSession();
    if (!session) {
      throw new GithubAppFlowError(
        "Sign in to Zeros before connecting the GitHub App.",
        "signed_out",
      );
    }
    const nonce = this.deps.randomNonce();
    if (!validNonce(nonce)) {
      throw new Error("GitHub App nonce generator returned invalid entropy");
    }
    // `complete()` reports through emitError, but `begin()` rejects straight
    // back to Settings, so it has to map control-plane failures to the same
    // reason vocabulary — otherwise the raw client error (and Electron's IPC
    // wrapper around it) is what the toast renders.
    let started;
    try {
      started = await this.deps.client.start(session.accessToken, {
        nonce,
        variantKey: "github.com",
        scheme: input.scheme,
        installFlow: input.installFlow,
      });
    } catch (error) {
      throw mapClientError(error);
    }
    // Cancelled while the two awaits above were outstanding. Persisting the
    // nonce now would leave a redeemable handoff, and for an already-authorized
    // app the browser redirects with no prompt — so a callback could still
    // connect and switch the selected method after the user said no.
    if (epoch !== this.cancelEpoch) return;
    this.deps.savePending({
      nonce,
      expiresAtMs: started.expiresAtMs,
    });
    try {
      await this.deps.openExternal(started.authorizeUrl);
    } catch (error) {
      this.deps.discardPending(nonce);
      throw new GithubAppFlowError(
        "Zeros couldn’t open your browser to authorize GitHub.",
        "oauth_failed",
        false,
        { cause: error },
      );
    }
  }

  /** Cancel only the desktop half of the browser flow. A callback that arrives
   * later is rejected as unsolicited and cannot replace the selected method. */
  cancel(): void {
    this.cancelEpoch += 1;
    this.deps.clearPending();
  }

  async complete(input: {
    nonce: string | null;
    error?: string | null;
  }): Promise<void> {
    if (!input.nonce || !validNonce(input.nonce)) {
      this.deps.emitError("invalid_callback");
      return;
    }
    const consumed = this.deps.consumePending(input.nonce);
    if (consumed.status !== "consumed") {
      this.deps.emitError(
        consumed.status === "mismatch" ? "nonce_mismatch" : "handoff_expired",
      );
      return;
    }
    const callbackError = mappedCallbackError(input.error);
    if (callbackError) {
      this.deps.emitError(callbackError);
      return;
    }

    try {
      const session = await this.deps.getSession();
      if (!session) {
        throw new GithubAppFlowError(
          "Sign in to Zeros before finishing the GitHub connection.",
          "signed_out",
        );
      }
      const result = await this.deps.client.exchange(
        session.accessToken,
        input.nonce,
      );
      if (!result.login || !result.variantKey) {
        throw new GithubAppFlowError(
          "The GitHub handoff omitted account metadata.",
          "oauth_failed",
        );
      }
      const next: GithubAppCredential = {
        method: "github-app",
        ...result,
        ownerSub: session.sub,
        gitHost: GITHUB_GIT_HOST,
        gitHttpUsername: GITHUB_GIT_HTTP_USERNAME,
      };

      try {
        await this.deps.withCredentialLock(async () => {
          const previous = await this.deps.credentialStore.get("github-app");
          const previousMethod =
            await this.deps.credentialStore.getSelectedMethod();
          await this.deps.credentialStore.set("github-app", next);
          try {
            await this.deps.credentialStore.setSelectedMethod("github-app");
          } catch (error) {
            try {
              if (previous) {
                await this.deps.credentialStore.set("github-app", previous);
              } else {
                await this.deps.credentialStore.clear("github-app");
              }
              await this.deps.credentialStore.setSelectedMethod(previousMethod);
            } catch {
              // Preserve the original commit failure. The store's own write
              // read-back checks make an incomplete rollback visible next probe.
            }
            throw error;
          }
        });
      } catch {
        throw new GithubAppFlowError(
          "The GitHub connection could not be stored securely.",
          "storage_failed",
        );
      }

      try {
        await this.deps.afterCredentialChange(next);
      } catch {
        // The durable commit succeeded. Engine re-seeding is retried at startup
        // and by the shared-store watcher, so it cannot turn success into a
        // misleading OAuth failure.
      }
      this.deps.emitConnected({
        login: result.login,
        installationCount: result.installationCount ?? 0,
      });
    } catch (error) {
      this.deps.emitError(mapClientError(error).reason);
    }
  }

  /** Return a fresh credential when rotation is needed. Transient failures
   *  throw without modifying the slot; callers decide whether a still-valid
   *  cached access token is safe for their operation. */
  async refresh(
    input: {
      force?: boolean;
    } = {},
  ): Promise<GithubAppCredential | null> {
    const initial = await this.deps.credentialStore.get("github-app");
    if (!initial) return null;
    const session = await this.deps.getSession();
    if (!session) {
      throw new GithubAppFlowError(
        "Sign in to Zeros to refresh the GitHub App.",
        "signed_out",
      );
    }
    if (!initial.ownerSub || initial.ownerSub !== session.sub) {
      throw new GithubAppFlowError(
        "This GitHub App connection belongs to another Zeros account.",
        "signed_out",
      );
    }
    const due =
      initial.expiresAtMs === undefined ||
      initial.expiresAtMs - this.now() < 60_000;
    if (!input.force && !due) return initial;

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshUnderLock(
        initial,
        input.force ?? false,
      ).finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async refreshUnderLock(
    initial: GithubAppCredential,
    force: boolean,
  ): Promise<GithubAppCredential | null> {
    return this.deps.withCredentialLock(async () => {
      const current = await this.deps.credentialStore.get("github-app");
      if (!current) return null;
      const session = await this.deps.getSession();
      if (!session) {
        throw new GithubAppFlowError(
          "Sign in to Zeros to refresh the GitHub App.",
          "signed_out",
        );
      }
      if (!current.ownerSub || current.ownerSub !== session.sub) {
        throw new GithubAppFlowError(
          "This GitHub App connection belongs to another Zeros account.",
          "signed_out",
        );
      }
      // A sibling dev worktree rotated while we waited for the shared lock.
      if (!sameRotatingPair(current, initial)) return current;
      const due =
        current.expiresAtMs === undefined ||
        current.expiresAtMs - this.now() < 60_000;
      if (!force && !due) return current;

      if (
        !current.refreshToken ||
        !current.refreshBinding ||
        (current.refreshTokenExpiresAtMs !== undefined &&
          current.refreshTokenExpiresAtMs <= this.now())
      ) {
        return this.clearTerminalCredential(current);
      }

      let refreshed;
      try {
        refreshed = await this.deps.client.refresh(
          session.accessToken,
          current.refreshToken,
          current.refreshBinding,
        );
      } catch (error) {
        const mapped = mapClientError(error);
        if (mapped.terminal) {
          return this.clearTerminalCredential(current);
        }
        try {
          await this.deps.afterTransientRefreshFailure?.(
            GITHUB_APP_TRANSIENT_REFRESH_RETRY_MS,
          );
        } catch {
          // Scheduling is best-effort and must never displace the original
          // transient failure or mutate the still-recoverable rotating pair.
        }
        throw mapped;
      }
      if (!refreshed.refreshToken) {
        throw new GithubAppFlowError(
          "GitHub returned an incomplete rotated credential.",
          "github_unavailable",
        );
      }
      const next: GithubAppCredential = {
        ...current,
        ...refreshed,
        method: "github-app",
        ownerSub: current.ownerSub,
      };
      const replaced = await this.deps.compareAndSetCredential(current, next);
      if (!replaced) {
        const latest = await this.deps.credentialStore.get("github-app");
        if (latest && !sameRotatingPair(latest, current)) return latest;
        throw new GithubAppFlowError(
          "The GitHub credential changed while it was refreshing.",
          "github_unavailable",
        );
      }
      await this.deps.afterCredentialChange(next);
      return next;
    });
  }

  private async clearTerminalCredential(
    current: GithubAppCredential,
  ): Promise<GithubAppCredential | null> {
    const removed = await this.deps.compareAndSetCredential(current, null);
    if (removed) {
      await this.deps.afterCredentialChange(null);
      return null;
    }
    const latest = await this.deps.credentialStore.get("github-app");
    if (latest && !sameRotatingPair(latest, current)) {
      return latest;
    }
    throw new GithubAppFlowError(
      "The expired GitHub credential could not be removed safely.",
      "github_unavailable",
    );
  }

  /** Explicit Settings Refresh: re-fetch installation/suspension/repository
   * metadata after first ensuring the short-lived user token is usable. */
  async refreshInstallations(): Promise<GithubAppCredential | null> {
    const current = await this.refresh();
    if (!current) return null;
    const session = await this.deps.getSession();
    if (!session || !current.ownerSub || current.ownerSub !== session.sub) {
      throw new GithubAppFlowError(
        "This GitHub App connection belongs to another Zeros account.",
        "signed_out",
      );
    }
    let refreshed;
    try {
      refreshed = await this.deps.client.refreshInstallations(
        session.accessToken,
        current.accessToken,
      );
    } catch (error) {
      throw mapClientError(error);
    }
    if (
      current.login &&
      current.login.toLowerCase() !== refreshed.login.toLowerCase()
    ) {
      throw new GithubAppFlowError(
        "GitHub returned a different account for this connection.",
        "oauth_failed",
      );
    }
    const {
      repositoryCount: _previousRepositoryCount,
      ...currentWithoutRepositoryCount
    } = current;
    const next: GithubAppCredential = {
      ...currentWithoutRepositoryCount,
      login: refreshed.login,
      installationCount: refreshed.installationCount,
      activeInstallationCount: refreshed.activeInstallationCount,
      ...(refreshed.repositoryCount !== undefined
        ? { repositoryCount: refreshed.repositoryCount }
        : {}),
      allRepositories: refreshed.allRepositories,
    };
    return this.deps.withCredentialLock(async () => {
      const latest = await this.deps.credentialStore.get("github-app");
      if (!latest) return null;
      if (!sameRotatingPair(latest, current)) return latest;
      const replaced = await this.deps.compareAndSetCredential(latest, next);
      if (!replaced) {
        return this.deps.credentialStore.get("github-app");
      }
      await this.deps.afterCredentialChange(next);
      return next;
    });
  }

  /** Best-effort remote revoke, then a CAS local removal. A transient backend
   *  outage never traps a user in a locally connected state. */
  async disconnect(): Promise<boolean> {
    return this.deps.withCredentialLock(async () => {
      const current = await this.deps.credentialStore.get("github-app");
      if (!current) return true;
      const session = await this.deps.getSession();
      if (
        session &&
        current.ownerSub &&
        current.ownerSub === session.sub &&
        current.refreshToken &&
        current.refreshBinding
      ) {
        try {
          await this.deps.client.revoke(
            session.accessToken,
            current.accessToken,
            current.refreshToken,
            current.refreshBinding,
          );
        } catch {
          // Local disconnect wins. GitHub user access tokens are short-lived;
          // a later full reconnect also supersedes this authorization.
        }
      }
      const removed = await this.deps.compareAndSetCredential(current, null);
      if (removed) await this.deps.afterCredentialChange(null);
      return removed;
    });
  }
}
