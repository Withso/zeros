// Engine-side, in-memory GitHub credential working copy.
//
// Electron main owns durable credentials. It seeds only the selected working
// credential over private stdin; the engine exposes its access token through
// the legacy TokenStore adapter used by the GitHub API and Git broker. Any
// engine-originated invalidation broadcasts method + reason only, never secret
// material.

import {
  GITHUB_GIT_HOST,
  isGithubAuthMethod,
  sanitizeGithubCredential,
  type GithubAuthMethod,
  type GithubCredential,
} from "@zeros/core/github-auth";
import type { TokenStore } from "./github";

export interface GithubCredentialChange {
  method: GithubAuthMethod;
  reason: "credential-invalid";
}

let credential: GithubCredential | null = null;
let selectedMethod: GithubAuthMethod | null = null;
let selectedGitHost: string | null = null;
let onChange: ((change: GithubCredentialChange) => void) | null = null;
const REFRESH_HANDOFF_TIMEOUT_MS = 20_000;

interface PendingRefresh {
  rejectedToken: string;
  promise: Promise<string | null>;
  resolve(value: string | null): void;
  timer: ReturnType<typeof setTimeout>;
}

let pendingRefresh: PendingRefresh | null = null;

export function setGithubCredentialChangeNotifier(
  fn: ((change: GithubCredentialChange) => void) | null,
): void {
  onChange = fn;
}

/** Host-originated seed. Method identity travels separately so a temporarily
 * absent credential still blocks fallthrough to a different ambient helper.
 * Refresh tokens deliberately remain in Electron main. */
export function seedGithubCredential(
  value: GithubCredential | null,
  method?: GithubAuthMethod | null,
): void {
  const parsed = sanitizeGithubCredential(value);
  selectedMethod =
    parsed?.method ?? (isGithubAuthMethod(method) ? method : null);
  selectedGitHost =
    parsed?.gitHost ?? (selectedMethod ? GITHUB_GIT_HOST : null);
  if (!parsed) {
    credential = null;
    if (pendingRefresh) {
      const pending = pendingRefresh;
      pendingRefresh = null;
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    return;
  }
  // A shared-store watcher may briefly re-send the exact rejected working
  // token while Electron is rotating its main-only refresh pair. Ignore that
  // stale seed so API/git retries cannot accidentally reuse it.
  if (pendingRefresh && parsed.accessToken === pendingRefresh.rejectedToken) {
    credential = null;
    return;
  }
  credential =
    parsed.method === "github-app"
      ? {
          method: parsed.method,
          accessToken: parsed.accessToken,
          gitHost: parsed.gitHost,
          gitHttpUsername: parsed.gitHttpUsername,
          ...(parsed.login ? { login: parsed.login } : {}),
          ...(parsed.expiresAtMs ? { expiresAtMs: parsed.expiresAtMs } : {}),
          ...(parsed.variantKey ? { variantKey: parsed.variantKey } : {}),
        }
      : parsed;
  if (pendingRefresh) {
    const pending = pendingRefresh;
    pendingRefresh = null;
    clearTimeout(pending.timer);
    pending.resolve(parsed.accessToken);
  }
}

/** Compatibility seed for an older local host bridge. */
export function seedGithubToken(token: string | null): void {
  seedGithubCredential(
    token
      ? {
          method: "pat",
          accessToken: token,
          gitHost: "github.com",
          gitHttpUsername: "x-access-token",
        }
      : null,
    token ? "pat" : null,
  );
}

export function getSeededGithubCredential(): GithubCredential | null {
  return credential ? { ...credential } : null;
}

export const engineGithubTokenStore: TokenStore = {
  async get() {
    return credential?.accessToken ?? null;
  },
  async getCredential() {
    return getSeededGithubCredential();
  },
  async ownsGitHost(host) {
    return selectedGitHost === host;
  },
  async refreshAfterRejection(rejectedToken) {
    if (pendingRefresh && pendingRefresh.rejectedToken === rejectedToken) {
      return pendingRefresh.promise;
    }
    if (!credential) return null;
    if (credential.accessToken !== rejectedToken) {
      return credential.accessToken;
    }
    if (credential.method !== "github-app") return undefined;

    const method = credential.method;
    credential = null;
    let resolvePending!: (value: string | null) => void;
    const promise = new Promise<string | null>((resolve) => {
      resolvePending = resolve;
    });
    const timer = setTimeout(() => {
      if (pendingRefresh?.promise !== promise) return;
      pendingRefresh = null;
      resolvePending(null);
    }, REFRESH_HANDOFF_TIMEOUT_MS);
    timer.unref?.();
    pendingRefresh = {
      rejectedToken,
      promise,
      resolve: resolvePending,
      timer,
    };
    onChange?.({ method, reason: "credential-invalid" });
    return promise;
  },
  async clearAfterRejection(rejectedToken) {
    if (!credential || credential.accessToken !== rejectedToken) {
      return false;
    }
    const method = credential.method;
    credential = null;
    if (pendingRefresh) {
      const pending = pendingRefresh;
      pendingRefresh = null;
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    onChange?.({ method, reason: "credential-invalid" });
    return true;
  },
  async set(token: string) {
    if (!credential) {
      credential = token
        ? {
            method: "pat",
            accessToken: token,
            gitHost: "github.com",
            gitHttpUsername: "x-access-token",
          }
        : null;
      return;
    }
    credential = { ...credential, accessToken: token };
  },
  async clear() {
    const method = credential?.method;
    credential = null;
    if (pendingRefresh) {
      const pending = pendingRefresh;
      pendingRefresh = null;
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    if (method) onChange?.({ method, reason: "credential-invalid" });
  },
};
