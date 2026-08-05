// ──────────────────────────────────────────────────────────
// IPC commands: encrypted secret store
// ──────────────────────────────────────────────────────────
//
// Storage moved off keytar on 2026-05-25 (the native C++ binding
// aborted the main process when something went wrong in
// Security.framework). The new path is Electron's safeStorage
// API + a JSON file in <userData>/secrets.json — see
// apps/desktop/electron/secret-store.ts.
//
// Do not import keytar here for legacy migration; loading the native
// binding is the crash vector this command avoids.
// ──────────────────────────────────────────────────────────

import { deleteSecret, getSecret, hasSecret, setSecret } from "../../secret-store";
import { isRendererKeychainAccount } from "../../keychain-accounts";
import type { CommandHandler } from "../router";

/** Reject any account the renderer doesn't legitimately own (see
 *  keychain-accounts.ts). Keeps a renderer compromise from reaching main-only
 *  secrets (github_oauth) or the legacy session store (auth_storage_* only). */
function assertAllowed(account: string, op: string): void {
  if (!isRendererKeychainAccount(account)) {
    // Don't echo the account back to a (possibly hostile) caller; log for us.
    console.warn(`[keychain] denied ${op} for non-allowlisted account "${account}"`);
    throw new Error(`keychain ${op} failed: account not permitted`);
  }
}

export const keychainSet: CommandHandler = async (args) => {
  const account = String(args.account ?? "");
  const value = String(args.value ?? "");
  if (!account) throw new Error("keychain set failed: missing account");
  assertAllowed(account, "set");
  try {
    setSecret(account, value);
  } catch (err) {
    throw new Error(
      `keychain set failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export const keychainGet: CommandHandler = async (args) => {
  const account = String(args.account ?? "");
  if (!account) throw new Error("keychain get failed: missing account");
  assertAllowed(account, "get");
  try {
    return getSecret(account);
  } catch (err) {
    throw new Error(
      `keychain get failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/** Presence probe — true when an entry EXISTS for the account, without
 *  decrypting it. keychain_get returns null for BOTH "never stored" and
 *  "stored but undecryptable" (secret-store swallows decrypt failures); this
 *  lets a read-modify-write caller (the env vault editor) tell them apart so
 *  it can refuse to edit — and later whole-map-save over — a value it
 *  couldn't actually read. */
export const keychainHas: CommandHandler = async (args) => {
  const account = String(args.account ?? "");
  if (!account) throw new Error("keychain has failed: missing account");
  assertAllowed(account, "has");
  try {
    return hasSecret(account);
  } catch (err) {
    throw new Error(
      `keychain has failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export const keychainDelete: CommandHandler = async (args) => {
  const account = String(args.account ?? "");
  if (!account) throw new Error("keychain delete failed: missing account");
  assertAllowed(account, "delete");
  try {
    deleteSecret(account);
  } catch (err) {
    throw new Error(
      `keychain delete failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
