import {
  providerCredentialsSchema,
  type ProviderCredentials,
} from "@zeros/protocol/provider-auth";
import { deleteSecret, getSecret, setSecret } from "./secret-store";
import type { CursorSubscriptionCredential } from "./cursor-subscription-controller";
import {
  readProviderAccounts,
  type ProviderAccountStore,
} from "./provider-account-store";
import { providerProfileDirectory } from "./provider-profile-directory";

// Main-only: deliberately absent from the renderer's keychain allowlist.
const CURSOR_SUBSCRIPTION_ACCOUNT = "cursor-subscription";
export function readLegacyCursorSubscription(): CursorSubscriptionCredential | null {
  const raw = getSecret(CURSOR_SUBSCRIPTION_ACCOUNT);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const parsed =
      providerCredentialsSchema.shape.cursorSubscription.safeParse(value);
    return parsed.success && parsed.data?.expiresAtMs
      ? { ...parsed.data, expiresAtMs: parsed.data.expiresAtMs }
      : null;
  } catch {
    return null;
  }
}
export function readCursorSubscription(
  store: ProviderAccountStore = readProviderAccounts("cursor"),
): CursorSubscriptionCredential | null {
  const account =
    store.method === "account"
      ? store.accounts.find((a) => a.id === store.activeId)
      : undefined;
  return (
    account?.credential ??
    (store.initialized && !account ? null : readLegacyCursorSubscription())
  );
}
export function writeCursorSubscription(
  value: CursorSubscriptionCredential | null,
): void {
  if (value) setSecret(CURSOR_SUBSCRIPTION_ACCOUNT, JSON.stringify(value));
  else deleteSecret(CURSOR_SUBSCRIPTION_ACCOUNT);
}
export function readProviderCredentialsForEngine(): ProviderCredentials {
  // Read each provider once: a sibling app can switch accounts between disk
  // reads. Credential bytes and the account identity must share one snapshot.
  const stores = {
    claude: readProviderAccounts("claude"),
    codex: readProviderAccounts("codex"),
    cursor: readProviderAccounts("cursor"),
  };
  const key = (account: string) => {
    const apiKey = getSecret(account);
    return apiKey ? { apiKey } : null;
  };
  return {
    claude: key("anthropic-api-key"),
    codex: key("openai-api-key"),
    cursor: key("cursor-api-key"),
    cursorSubscription: readCursorSubscription(stores.cursor),
    accountProfiles: Object.fromEntries(
      (["claude", "codex", "cursor"] as const).map((provider) => {
        const store = stores[provider];
        const account = store.accounts.find((a) => a.id === store.activeId);
        if (store.method !== "account" || !store.initialized)
          return [provider, null];
        return [
          provider,
          {
            id: account?.id ?? "00000000-0000-4000-8000-000000000000",
            state: account?.state ?? "disconnected",
            ...(provider !== "cursor"
              ? {
                  configDir: account
                    ? account.configDir
                    : providerProfileDirectory(provider, "unconnected"),
                }
              : {}),
          },
        ];
      }),
    ) as NonNullable<ProviderCredentials["accountProfiles"]>,
  };
}
