// Main-process GitHub credential store.
//
// Durable tokens live in method-addressed safeStorage slots. The active method
// is non-secret TOML state supplied through the dependency adapter. gh CLI is
// intentionally borrowed on demand and is never copied into safeStorage.

import { GITHUB_APP_ACCOUNT, GITHUB_APP_PARKED_ACCOUNT, githubAppSlotsForOwner } from "./github-app-accounts";
import {
  GITHUB_GIT_HOST,
  GITHUB_GIT_HTTP_USERNAME,
  githubCredentialToken,
  isGithubAuthMethod,
  sanitizeGithubCredential,
  type GithubAuthMethod,
  type GithubCredential,
  type GithubCredentialStore,
} from "@zeros/protocol/github-auth";

export const GITHUB_LEGACY_ACCOUNT = "github_oauth";
export const GITHUB_PAT_ACCOUNT = "github.pat";
export { GITHUB_APP_ACCOUNT } from "./github-app-accounts";

export function isGithubCredentialAccount(account: string): boolean {
  return account === GITHUB_APP_ACCOUNT || account === GITHUB_LEGACY_ACCOUNT ||
    account === GITHUB_PAT_ACCOUNT || account.startsWith(`${GITHUB_PAT_ACCOUNT}.`);
}

export interface GithubCredentialStoreDependencies {
  currentAccount?(): string | null;
  readSecret(account: string): string | null;
  updateSecrets(keys: readonly string[], edit: (values: Record<string, string | null>) => Record<string, string | null>): void;
  verifyIdentity(token: string): Promise<{ login: string; githubUserId: string }>;
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
  function currentSlot(method: "pat" | "github-app") {
    const owner = method === "pat" && deps.currentAccount?.();
    return owner ? `${GITHUB_PAT_ACCOUNT}.${owner}` : accountFor(method);
  }
  type Stored = Exclude<GithubCredential, { method: "gh-cli" }>;
  let verifyAfterMs = 0;
  async function verified(credential: Stored): Promise<Stored> {
    if (credential.githubUserId) return credential;
    // An unreachable GitHub or a dead token leaves the identity unknown, not mismatched.
    return deps.verifyIdentity(credential.accessToken).then(identity => ({ ...credential, ...identity }), () => credential);
  }

  // Check both slots before publishing a candidate or using a login-only record.
  // The final compare-and-swap also fences saves from a second Mac process.
  // Reads pass enforce=false: a pair saved before this rule keeps working.
  async function reconcile(method: Stored["method"], candidate?: Stored, enforce = true): Promise<Stored | null> {
    const owner = deps.currentAccount?.() ?? null;
    const keys = [GITHUB_APP_ACCOUNT, GITHUB_APP_PARKED_ACCOUNT, currentSlot("pat")];
    const before = Object.fromEntries(keys.map(key => [key, deps.readSecret(key)]));
    const slots = githubAppSlotsForOwner(before, owner);
    const stored = (kind: Stored["method"]) => {
      const record = parseSlot(slots[currentSlot(kind)] ?? null, kind);
      return record && record.method !== "gh-cli" && (record.ownerSub ?? null) === owner ? record : null;
    };
    const value = candidate ?? stored(method);
    if (!value) return null;
    const peerMethod = method === "pat" ? "github-app" : "pat";
    const peer = stored(peerMethod);
    const [next, other] = await Promise.all([verified(value), peer ? verified(peer) : null]);
    if (owner !== (deps.currentAccount?.() ?? null)) throw new Error("The Zeros account changed while verifying GitHub.");
    if (enforce && other?.githubUserId && next.githubUserId && other.githubUserId !== next.githubUserId) {
      throw new Error(`This credential belongs to @${next.login}. Use a credential for @${other.login}, or change accounts in Personal → Integrations → GitHub.`);
    }
    if (candidate || next !== value || other !== peer) {
      deps.updateSecrets(keys, current => {
        if (keys.some(key => current[key] !== before[key])) throw new Error("Your GitHub connection changed. Try again.");
        const result = { ...slots, [currentSlot(method)]: JSON.stringify(next) };
        if (other && other !== peer) result[currentSlot(peerMethod)] = JSON.stringify(other);
        return result;
      });
    }
    return next;
  }
  const store: HostGithubCredentialStore = {
    async getSelectedMethod() {
      // Product default: gh CLI is the selected row on a fresh install.
      return deps.readSelectedMethod() ?? "gh-cli";
    },

    async setSelectedMethod(method) {
      if (!isGithubAuthMethod(method)) {
        throw new Error(`Unknown GitHub authentication method: ${method}`);
      }
      if (method !== "gh-cli") await reconcile(method);
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
      return parseSlot(deps.readSecret(currentSlot(method)), method);
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

      if (credential.method === "pat" && credential.ownerSub !== (deps.currentAccount?.() ?? undefined)) {
        throw new Error("The Zeros account changed before the token was saved.");
      }
      const account = currentSlot(method);
      if (credential.method === "gh-cli") return;
      await reconcile(method, credential);

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
      deps.deleteSecret(currentSlot(method));
    },

    async getSelectedCredential() {
      const method = await store.getSelectedMethod();
      if (method === "gh-cli" && store.isExplicitlyDisconnected()) {
        return null;
      }
      let selected = await store.get(method);
      if (selected && selected.method !== "gh-cli" && !selected.githubUserId && Date.now() >= verifyAfterMs) {
        selected = await reconcile(selected.method, undefined, false).catch(() => null) ?? selected;
        if (!selected.githubUserId) verifyAfterMs = Date.now() + 60_000;
      }
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
      // A pre-account token has no owner evidence. It belongs to device Local.
      return deps.currentAccount?.() ? null : deps.readSecret(GITHUB_LEGACY_ACCOUNT);
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
