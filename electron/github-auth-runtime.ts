// Production wiring for the main-process GitHub credential store.

import type {
  GithubAuthMethod,
  GithubCredential,
} from "@zeros/core/github-auth";
import {
  GITHUB_GIT_HOST,
  GITHUB_GIT_HTTP_USERNAME,
  githubCredentialToken,
  sanitizeGithubCredential,
} from "@zeros/core/github-auth";

import { opSettingsResolve, opSettingsWrite } from "../src/engine/settings";
import { readGhCliCredential, type TokenStore } from "../src/engine/git/github";
import {
  deleteSecret,
  getSecret,
  replaceSecretIfUnchanged,
  setSecret,
} from "./secret-store";
import {
  GITHUB_APP_ACCOUNT,
  createGithubCredentialStore,
  migrateLegacyGithubCredential,
} from "./github-credential-store";
import { githubCredentialForEngine } from "./github-engine-credential";
import { getSessionUserForMain } from "./ipc/commands/auth-session";

interface GithubSettingsTable {
  auth_method?: unknown;
  disconnected_at?: unknown;
}

function githubSettings(): GithubSettingsTable {
  const table = opSettingsResolve().effective.github;
  return table && typeof table === "object" && !Array.isArray(table)
    ? (table as GithubSettingsTable)
    : {};
}

function readSelectedMethod(): GithubAuthMethod | null {
  const method = githubSettings().auth_method;
  return method === "gh-cli" || method === "github-app" || method === "pat"
    ? method
    : null;
}

function writeGithubSettings(patch: Record<string, unknown>): void {
  opSettingsWrite("user", { github: patch });
}

export const githubCredentialStore = createGithubCredentialStore({
  readSecret: getSecret,
  writeSecret: setSecret,
  deleteSecret,
  readSelectedMethod,
  writeSelectedMethod(method) {
    // Clearing the durable "stop using gh" marker is the store's decision, not
    // this adapter's: an explicit gh-cli selection clears it, while an
    // automatic fallback must leave it in place. Writing `disconnected_at:
    // null` here would delete the key (a null patch leaf is a delete) on every
    // write and silently re-adopt a gh credential the user disconnected.
    writeGithubSettings({ auth_method: method });
  },
  readDisconnectedAt() {
    const value = githubSettings().disconnected_at;
    return typeof value === "string" && value.length > 0 ? value : null;
  },
  writeDisconnectedAt(value) {
    writeGithubSettings({ disconnected_at: value });
  },
  readGhCliCredential,
});

/** Cross-process compare-and-swap for GitHub's single-use refresh rotation.
 *  Dev worktrees share safeStorage; a stale refresh response must never replace
 *  a newer pair installed by a sibling process. */
export async function replaceGithubAppCredentialIfCurrent(
  expected: Extract<GithubCredential, { method: "github-app" }>,
  next: Extract<GithubCredential, { method: "github-app" }> | null,
): Promise<boolean> {
  const raw = getSecret(GITHUB_APP_ACCOUNT);
  if (!raw) return false;
  let current: GithubCredential | null;
  try {
    current = sanitizeGithubCredential(JSON.parse(raw));
  } catch {
    return false;
  }
  if (
    current?.method !== "github-app" ||
    githubCredentialToken(current) !== githubCredentialToken(expected) ||
    current.refreshToken !== expected.refreshToken ||
    current.refreshBinding !== expected.refreshBinding ||
    current.ownerSub !== expected.ownerSub
  ) {
    return false;
  }
  const sanitizedNext = next ? sanitizeGithubCredential(next) : null;
  if (next && sanitizedNext?.method !== "github-app") {
    throw new Error("Invalid replacement GitHub App credential");
  }
  return replaceSecretIfUnchanged(
    GITHUB_APP_ACCOUNT,
    raw,
    sanitizedNext ? JSON.stringify(sanitizedNext) : null,
  );
}

/** Adapter retained while the engine GitHub API consumes a selected TokenStore.
 *  The method-addressed durable store remains the source of truth. */
async function selectedWorkingCredential(): Promise<GithubCredential | null> {
  const selected = await githubCredentialStore.getSelectedCredential();
  return githubCredentialForEngine(
    selected,
    getSessionUserForMain()?.sub ?? null,
  );
}

export const githubSelectedTokenStore: TokenStore = {
  async get() {
    return (await selectedWorkingCredential())?.accessToken ?? null;
  },
  async getCredential() {
    return selectedWorkingCredential();
  },
  async ownsGitHost(host) {
    if (host !== GITHUB_GIT_HOST) return false;
    // All three current methods are GitHub-owned. Keep the broker active even
    // while the selected slot is disconnected, expired, or refreshing so Git
    // cannot silently borrow a different system helper/account.
    await githubCredentialStore.getSelectedMethod();
    return true;
  },
  async refreshAfterRejection(rejectedToken) {
    const method = await githubCredentialStore.getSelectedMethod();
    if (method !== "github-app") return undefined;
    const current = await selectedWorkingCredential();
    if (
      current?.method === "github-app" &&
      current.accessToken !== rejectedToken
    ) {
      return current.accessToken;
    }
    try {
      // Lazy to avoid a module cycle during Electron bootstrap:
      // github-app-flow depends on this store for its controller wiring.
      const { refreshGithubAppCredential } = await import("./github-app-flow");
      const refreshed = await refreshGithubAppCredential({ force: true });
      const projected = githubCredentialForEngine(
        refreshed,
        getSessionUserForMain()?.sub ?? null,
      );
      return projected?.method === "github-app" &&
        projected.accessToken !== rejectedToken
        ? projected.accessToken
        : null;
    } catch {
      // Transient refresh failures preserve the durable rotating pair.
      return null;
    }
  },
  async clearAfterRejection(rejectedToken) {
    const method = await githubCredentialStore.getSelectedMethod();
    if (method === "gh-cli") {
      const current = await githubCredentialStore.get("gh-cli");
      if (githubCredentialToken(current) !== rejectedToken) return false;
      await githubCredentialStore.markExplicitlyDisconnected();
      return true;
    }
    if (method === "pat") {
      // Deliberately NOT deleted. A PAT is typed by hand and has no undo on this
      // path, while the trigger is two GitHub 401s in quick succession — exactly
      // what a GitHub incident looks like. Settings re-verifies the token on
      // open and shows "GitHub revoked this connection. Reconnect to continue.",
      // so a genuinely dead token is still surfaced; a transient one survives.
      // (github-app is re-mintable, so it keeps the destructive path below.)
      return false;
    }
    const account = GITHUB_APP_ACCOUNT;
    const raw = getSecret(account);
    if (!raw) return false;
    let current: GithubCredential | null;
    try {
      current = sanitizeGithubCredential(JSON.parse(raw));
    } catch {
      return false;
    }
    if (
      current?.method !== method ||
      githubCredentialToken(current) !== rejectedToken
    ) {
      return false;
    }
    return replaceSecretIfUnchanged(account, raw, null);
  },
  async set(token) {
    const method = await githubCredentialStore.getSelectedMethod();
    if (method === "gh-cli") return;
    const previous = await githubCredentialStore.get(method);
    const credential: GithubCredential =
      method === "pat"
        ? {
            method,
            accessToken: token,
            gitHost: previous?.gitHost ?? GITHUB_GIT_HOST,
            gitHttpUsername:
              previous?.gitHttpUsername ?? GITHUB_GIT_HTTP_USERNAME,
            ...(previous?.login ? { login: previous.login } : {}),
          }
        : {
            method,
            accessToken: token,
            gitHost: previous?.gitHost ?? GITHUB_GIT_HOST,
            gitHttpUsername:
              previous?.gitHttpUsername ?? GITHUB_GIT_HTTP_USERNAME,
            ...(previous?.method === "github-app" && previous.refreshToken
              ? { refreshToken: previous.refreshToken }
              : {}),
            ...(previous?.method === "github-app" && previous.refreshBinding
              ? { refreshBinding: previous.refreshBinding }
              : {}),
            ...(previous?.login ? { login: previous.login } : {}),
            ...(previous?.method === "github-app" && previous.expiresAtMs
              ? { expiresAtMs: previous.expiresAtMs }
              : {}),
            ...(previous?.method === "github-app" && previous.variantKey
              ? { variantKey: previous.variantKey }
              : {}),
            ...(previous?.method === "github-app" && previous.ownerSub
              ? { ownerSub: previous.ownerSub }
              : {}),
            ...(previous?.method === "github-app" &&
            previous.refreshTokenExpiresAtMs
              ? {
                  refreshTokenExpiresAtMs: previous.refreshTokenExpiresAtMs,
                }
              : {}),
            ...(previous?.method === "github-app" &&
            previous.installationCount !== undefined
              ? { installationCount: previous.installationCount }
              : {}),
            ...(previous?.method === "github-app" &&
            previous.activeInstallationCount !== undefined
              ? {
                  activeInstallationCount: previous.activeInstallationCount,
                }
              : {}),
            ...(previous?.method === "github-app" &&
            previous.repositoryCount !== undefined
              ? { repositoryCount: previous.repositoryCount }
              : {}),
            ...(previous?.method === "github-app" &&
            previous.allRepositories !== undefined
              ? { allRepositories: previous.allRepositories }
              : {}),
          };
    await githubCredentialStore.set(method, credential);
  },
  async clear() {
    const method = await githubCredentialStore.getSelectedMethod();
    if (method === "gh-cli") {
      await githubCredentialStore.markExplicitlyDisconnected();
    } else {
      await githubCredentialStore.clear(method);
    }
  },
};

/** Run after the macOS login-shell PATH is hydrated, before engine spawn. */
export async function initializeGithubCredentialStore(): Promise<void> {
  await migrateLegacyGithubCredential(githubCredentialStore);
}
