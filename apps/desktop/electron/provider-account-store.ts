import { z } from "zod";
import {
  subscriptionAccountSchema,
  type BrowserSubscriptionProvider,
} from "@zeros/protocol/provider-auth";
import {
  createSecretIfAbsent,
  getSecret,
  hasSecret,
  replaceSecretIfUnchanged,
} from "./secret-store";

const storedAccountSchema = subscriptionAccountSchema.extend({
  // Missing configDir is the existing device CLI account, migrated in place.
  configDir: z.string().min(1).max(4096).optional(),
  credential: z
    .object({
      apiKey: z.string().min(1).max(32768),
      expiresAtMs: z.number().positive(),
      email: z.string().max(320).optional(),
    })
    .optional(),
});
const storeSchema = z
  .object({
    version: z.literal(1),
    method: z.enum(["account", "cli", "apiKey"]),
    activeId: z.string().uuid().optional(),
    initialized: z.boolean().optional(),
    methodSelected: z.boolean().optional(),
    accounts: z.array(storedAccountSchema).max(20),
  })
  .strict();
export type StoredProviderAccount = z.infer<typeof storedAccountSchema>;
export type ProviderAccountStore = z.infer<typeof storeSchema>;
export const providerAccountStoreKey = (
  provider: BrowserSubscriptionProvider,
) => `provider-accounts-${provider}`;
const empty = (): ProviderAccountStore => ({
  version: 1,
  method: "account",
  accounts: [],
});

export function readProviderAccounts(
  provider: BrowserSubscriptionProvider,
): ProviderAccountStore {
  const key = providerAccountStoreKey(provider);
  const raw = getSecret(key);
  if (!raw) {
    if (hasSecret(key))
      throw new Error("Saved accounts could not be unlocked.");
    return empty();
  }
  try {
    return storeSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Saved accounts could not be read.");
  }
}

/** Merge under the existing cross-process secret-store CAS. A second app
 * instance cannot overwrite a newly-added account with its older snapshot. */
export function updateProviderAccounts(
  provider: BrowserSubscriptionProvider,
  update: (current: ProviderAccountStore) => ProviderAccountStore,
): ProviderAccountStore {
  const key = providerAccountStoreKey(provider);
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = getSecret(key);
    if (!raw && hasSecret(key))
      throw new Error("Saved accounts could not be unlocked.");
    let current: ProviderAccountStore;
    try {
      current = raw ? storeSchema.parse(JSON.parse(raw)) : empty();
    } catch {
      throw new Error("Saved accounts could not be read.");
    }
    const next = storeSchema.parse(update(current));
    const encoded = JSON.stringify(next);
    if (encoded === raw) return next;
    if (
      raw
        ? replaceSecretIfUnchanged(key, raw, encoded)
        : createSecretIfAbsent(key, encoded)
    )
      return next;
  }
  throw new Error("Accounts changed in another window. Refresh and try again.");
}

export function selectedProviderAccount(
  provider: BrowserSubscriptionProvider,
): StoredProviderAccount | null {
  const store = readProviderAccounts(provider);
  return store.method === "account"
    ? (store.accounts.find((a) => a.id === store.activeId) ?? null)
    : null;
}

export function publicProviderAccounts(store: ProviderAccountStore) {
  return store.accounts.map(
    ({
      id,
      state,
      email,
      plan,
      organization,
      expiresAtMs,
      configDir,
      credential,
    }) => ({
      id,
      state,
      ...(!configDir && !credential ? { deviceAccount: true } : {}),
      ...(email ? { email } : {}),
      ...(plan ? { plan } : {}),
      ...(organization ? { organization } : {}),
      ...(expiresAtMs ? { expiresAtMs } : {}),
    }),
  );
}
