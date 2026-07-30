// Main-process GitHub credential store.
//
// Durable tokens live in method-addressed safeStorage slots. The active method
// is non-secret TOML state supplied through the dependency adapter. gh CLI is
// intentionally borrowed on demand and is never copied into safeStorage.

import {
  GITHUB_GIT_HOST,
  GITHUB_GIT_HTTP_USERNAME,
  githubCredentialToken,
  isGithubAuthMethod,
  sanitizeGithubCredential,
  type GithubAuthMethod,
  type GithubCredential,
  type GithubCredentialStore,
} from "@zeros/core/github-auth";

export const GITHUB_LEGACY_ACCOUNT = "github_oauth";
export const GITHUB_PAT_ACCOUNT = "github.pat";
export const GITHUB_APP_ACCOUNT = "github.app";

export interface GithubCredentialStoreDependencies {
  readSecret(account: string): string | null;
  writeSecret(account: string, value: string): void;
  deleteSecret(account: string): void;
  readSelectedMethod(): GithubAuthMethod | null;
  writeSelectedMethod(method: GithubAuthMethod): void;
  readDisconnectedAt(): string | null;
  writeDisconnectedAt(value: string | null): void;
  readGhCliCredential(): Promise<GithubCredential | null>;
}

export interface HostGithubCredentialStore extends GithubCredentialStore {
  getSelectedCredential(): Promise<GithubCredential | null>;
  /** Automatic fallback updates only the active row. Unlike an explicit user
   * selection, it must not clear the durable "stop using gh" marker. */
  setFallbackMethod(method: GithubAuthMethod): Promise<void>;
  isExplicitlyDisconnected(): boolean;
  markExplicitlyDisconnected(): Promise<void>;
  readLegacyToken(): string | null;
  deleteLegacyToken(): void;
}

function accountFor(method: Exclude<GithubAuthMethod, "gh-cli">): string {
  return method === "pat" ? GITHUB_PAT_ACCOUNT : GITHUB_APP_ACCOUNT;
}

function parseSlot(raw: string | null, method: GithubAuthMethod) {
  if (!raw) return null;
  try {
    const credential = sanitizeGithubCredential(JSON.parse(raw));
    return credential?.method === method ? credential : null;
  } catch {
    return null;
  }
}

export function createGithubCredentialStore(
  deps: GithubCredentialStoreDependencies,
): HostGithubCredentialStore {
  const store: HostGithubCredentialStore = {
    async getSelectedMethod() {
      // Product default: gh CLI is the selected row on a fresh install.
      return deps.readSelectedMethod() ?? "gh-cli";
    },

    async setSelectedMethod(method) {
      if (!isGithubAuthMethod(method)) {
        throw new Error(`Unknown GitHub authentication method: ${method}`);
      }
      deps.writeSelectedMethod(method);
      // The marker suppresses only borrowed gh credentials. Switching between
      // PAT and App must not silently re-enable an inactive CLI row.
      if (method === "gh-cli") deps.writeDisconnectedAt(null);
    },

    async setFallbackMethod(method) {
      if (!isGithubAuthMethod(method)) {
        throw new Error(`Unknown GitHub authentication method: ${method}`);
      }
      deps.writeSelectedMethod(method);
    },

    async get(method) {
      if (method === "gh-cli") {
        const credential = await deps.readGhCliCredential();
        return credential?.method === "gh-cli" ? credential : null;
      }
      return parseSlot(deps.readSecret(accountFor(method)), method);
    },

    async set(method, value) {
      const credential = sanitizeGithubCredential(value);
      if (!credential || credential.method !== method) {
        throw new Error(
          `GitHub credential method does not match destination '${method}'`,
        );
      }
      if (method === "gh-cli") {
        // gh owns this token. Selecting the method is durable; copying its
        // credential would create a stale second source of truth.
        return;
      }

      const account = accountFor(method);
      deps.writeSecret(account, JSON.stringify(credential));

      // A safeStorage encryption or whole-file write can fail. Confirm the
      // exact token reached the destination before callers switch methods or a
      // migration deletes its source.
      const written = parseSlot(deps.readSecret(account), method);
      if (
        !written ||
        githubCredentialToken(written) !== githubCredentialToken(credential)
      ) {
        throw new Error(`GitHub ${method} credential failed read-back`);
      }
    },

    async clear(method) {
      if (method === "gh-cli") return;
      deps.deleteSecret(accountFor(method));
    },

    async getSelectedCredential() {
      const method = await store.getSelectedMethod();
      if (method === "gh-cli" && store.isExplicitlyDisconnected()) {
        return null;
      }
      const selected = await store.get(method);
      if (selected) return selected;
      // One-release downgrade/recovery bridge: use the legacy token until the
      // inferring migration successfully writes and verifies its destination.
      const legacyToken = store.readLegacyToken()?.trim();
      return legacyToken
        ? {
            method: "pat",
            accessToken: legacyToken,
            gitHost: GITHUB_GIT_HOST,
            gitHttpUsername: GITHUB_GIT_HTTP_USERNAME,
          }
        : null;
    },

    isExplicitlyDisconnected() {
      return deps.readDisconnectedAt() !== null;
    },

    async markExplicitlyDisconnected() {
      deps.writeDisconnectedAt(new Date().toISOString());
    },

    readLegacyToken() {
      return deps.readSecret(GITHUB_LEGACY_ACCOUNT);
    },

    deleteLegacyToken() {
      deps.deleteSecret(GITHUB_LEGACY_ACCOUNT);
    },
  };
  return store;
}

/** One-release migration from the old undifferentiated token slot.
 *
 * The destination is written and verified before the legacy slot is deleted.
 * Absence of the source normally makes this idempotent, but the delete can fail
 * on its own (the secret store now throws on lock timeout, and the caller treats
 * a failed migration as deferred), and a one-release downgrade can recreate the
 * source. So the destination is also checked: a newer release's PAT must not be
 * replaced by the stale legacy copy, and the user's explicit method choice must
 * not be overridden on a re-run.
 */
export async function migrateLegacyGithubCredential(
  store: HostGithubCredentialStore,
): Promise<GithubAuthMethod | null> {
  const legacyToken = store.readLegacyToken()?.trim();
  if (!legacyToken) return null;

  const gh = await store.get("gh-cli").catch(() => null);
  if (githubCredentialToken(gh) === legacyToken) {
    await store.setSelectedMethod("gh-cli");
    store.deleteLegacyToken();
    return "gh-cli";
  }

  const existingPat = await store.get("pat").catch(() => null);
  if (existingPat) {
    // The destination is already populated, so this migration has either
    // completed once (`setSelectedMethod` runs before the delete below, so the
    // selection was written too) or a later release owns the slot. Either way,
    // retire the source WITHOUT touching the method the user is on — a token
    // that happens to equal the legacy one used to fall through here and reset
    // an explicit GitHub App selection back to PAT.
    store.deleteLegacyToken();
    return null;
  }

  await store.set("pat", {
    method: "pat",
    accessToken: legacyToken,
    gitHost: GITHUB_GIT_HOST,
    gitHttpUsername: GITHUB_GIT_HTTP_USERNAME,
  });
  await store.setSelectedMethod("pat");
  store.deleteLegacyToken();
  return "pat";
}
