import { isNativeRuntime, nativeInvoke } from "./runtime";
import { providerAuthChanged } from "./provider-auth-state";

// The browser fallback is memory-only so credentials never enter cleartext localStorage.
const memoryStore = new Map<string, string>();

export async function setSecret(account: string, value: string): Promise<void> {
  if (!isNativeRuntime()) {
    memoryStore.set(account, value);
    return;
  }
  await nativeInvoke<void>("keychain_set", { account, value });
  if (Object.values(SECRET_ACCOUNTS).some((value) => value === account))
    providerAuthChanged();
}

export async function getSecret(account: string): Promise<string | null> {
  if (!isNativeRuntime()) {
    return memoryStore.has(account) ? (memoryStore.get(account) ?? null) : null;
  }
  const result = await nativeInvoke<string | null>("keychain_get", { account });
  return result ?? null;
}

/** Presence does not decrypt. If getSecret returns null here, an editor must distinguish absent from unreadable before overwriting. */
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
  if (Object.values(SECRET_ACCOUNTS).some((value) => value === account))
    providerAuthChanged();
}

// These account names are persisted secret-store identifiers.
export const SECRET_ACCOUNTS = {
  OPENAI_API_KEY: "openai-api-key",
  ANTHROPIC_API_KEY: "anthropic-api-key",
  CURSOR_API_KEY: "cursor-api-key",
} as const;
