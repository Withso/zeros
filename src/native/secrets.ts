// ──────────────────────────────────────────────────────────
// Phase 2-C — Keychain-backed secrets API
// ──────────────────────────────────────────────────────────
//
// Reads/writes values in the macOS login keychain via the Electron
// main process (legacy native builds used src-tauri/src/secrets.rs).
// Outside a native runtime (e.g. `pnpm dev` in a
// plain browser), everything falls back to an in-memory store so the
// dev harness keeps working for the life of the session — the Mac build
// always wins because `isNativeRuntime()` returns true.
//
// The fallback is deliberately in-memory only: persisting API keys to
// localStorage would leave them in clear text at rest, readable by any
// injected script. Dev secrets therefore survive reloads only on the
// native build (real Keychain); a browser reload re-prompts.
//
// Call sites: store.tsx (api key load), Settings page (api key save),
// anywhere else secrets live. Never write API keys to settings.json
// or localStorage on the Mac build — this wrapper is the one path.
// ──────────────────────────────────────────────────────────

import { isNativeRuntime, nativeInvoke } from "./runtime";

// Ephemeral, session-scoped fallback for the non-native dev harness.
// Never persisted — see the header note on clear-text-at-rest.
const memoryStore = new Map<string, string>();

export async function setSecret(account: string, value: string): Promise<void> {
  if (!isNativeRuntime()) {
    memoryStore.set(account, value);
    return;
  }
  await nativeInvoke<void>("keychain_set", { account, value });
}

export async function getSecret(account: string): Promise<string | null> {
  if (!isNativeRuntime()) {
    return memoryStore.has(account) ? (memoryStore.get(account) ?? null) : null;
  }
  const result = await nativeInvoke<string | null>("keychain_get", { account });
  return result ?? null;
}

/** Whether an entry EXISTS for `account` — key presence only, no decrypt.
 *  getSecret returns null for BOTH "never stored" and "stored but
 *  undecryptable" (the store swallows decrypt failures); pairing it with this
 *  probe lets a read-modify-write caller (the env vault editor) tell the two
 *  apart and refuse to edit a value it couldn't actually read. */
export async function hasSecret(account: string): Promise<boolean> {
  if (!isNativeRuntime()) {
    return memoryStore.has(account);
  }
  const result = await nativeInvoke<boolean>("keychain_has", { account });
  return result === true;
}

export async function deleteSecret(account: string): Promise<void> {
  if (!isNativeRuntime()) {
    memoryStore.delete(account);
    return;
  }
  await nativeInvoke<void>("keychain_delete", { account });
}

// ── Well-known account names ────────────────────────────────
// Keep these centralised so all callers agree on the same slot
// (mis-typing "anthropic-key" vs "anthropic-api-key" would silently
// split reads from writes).
export const SECRET_ACCOUNTS = {
  OPENAI_API_KEY: "openai-api-key",
  ANTHROPIC_API_KEY: "anthropic-api-key",
  CURSOR_API_KEY: "cursor-api-key",
} as const;
