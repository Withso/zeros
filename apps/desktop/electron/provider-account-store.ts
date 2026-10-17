import { z } from "zod";
import {
  subscriptionAccountSchema,
  type BrowserSubscriptionProvider,
} from "@zeros/protocol/provider-auth";
import { readSecretValues, updateSecretValues } from "./secret-store";

const storedAccountSchema = subscriptionAccountSchema.extend({
  // Private credential generation, not public account identity or metadata.
  revision: z.number().int().nonnegative().optional(),
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
    selectionRevision: z.number().int().nonnegative().optional(),
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
// Keep the strict v1 account record readable by older development worktrees.
// Private generations live in a companion encrypted entry, committed atomically.
const revisionsSchema = z
  .object({
    selection: z.number().int().nonnegative().optional(),
    accounts: z.record(z.string().uuid(), z.number().int().nonnegative()),
  })
  .strict();
const revisionKey = (provider: BrowserSubscriptionProvider) =>
  `${providerAccountStoreKey(provider)}:revisions`;

function decodeAccounts(
  provider: BrowserSubscriptionProvider,
  values: Record<string, string | null>,
): ProviderAccountStore {
  const raw = values[providerAccountStoreKey(provider)];
  const metadata = values[revisionKey(provider)];
  try {
    const store = raw ? storeSchema.parse(JSON.parse(raw)) : empty();
    if (!metadata) return store;
    const revisions = revisionsSchema.parse(JSON.parse(metadata));
    // Reads and mutations must use the same schema ordering: the manager
    // compares snapshots before publishing credential-change invalidations.
    return storeSchema.parse({
      ...store,
      selectionRevision: revisions.selection,
      accounts: store.accounts.map((account) => ({
        ...account,
        revision: revisions.accounts[account.id],
      })),
    });
  } catch {
    throw new Error("Saved accounts could not be read.");
  }
}

export function readProviderAccounts(
  provider: BrowserSubscriptionProvider,
): ProviderAccountStore {
  return decodeAccounts(
    provider,
    readSecretValues([
      providerAccountStoreKey(provider),
      revisionKey(provider),
    ]),
  );
}

/** Merge under the existing cross-process secret-store lock. A second app
 * instance cannot overwrite a newly-added account with its older snapshot. */
export function updateProviderAccounts(
  provider: BrowserSubscriptionProvider,
  update: (current: ProviderAccountStore) => ProviderAccountStore,
): ProviderAccountStore {
  const key = providerAccountStoreKey(provider);
  const metadata = revisionKey(provider);
  let next!: ProviderAccountStore;
  updateSecretValues([key, metadata], (values) => {
    next = storeSchema.parse(update(decodeAccounts(provider, values)));
    const { selectionRevision, accounts, ...legacy } = next;
    return {
      [key]: JSON.stringify({
        ...legacy,
        accounts: accounts.map(
          ({ revision: _revision, ...account }) => account,
        ),
      }),
      [metadata]: JSON.stringify({
        selection: selectionRevision,
        accounts: Object.fromEntries(
          accounts
            .filter((account) => account.revision !== undefined)
            .map((account) => [account.id, account.revision]),
        ),
      }),
    };
  });
  return next;
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
