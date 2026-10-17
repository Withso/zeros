import { randomUUID } from "node:crypto";
import type {
  SubscriptionAccount,
  SubscriptionDriver,
} from "./provider-subscription-controller";
import {
  publicProviderAccounts,
  type ProviderAccountStore,
  type StoredProviderAccount,
} from "./provider-account-store";

type LoginOptions = Parameters<SubscriptionDriver["login"]>[0];
function sameSelection(
  current: ProviderAccountStore,
  previous: ProviderAccountStore,
): boolean {
  return (
    current.activeId === previous.activeId &&
    current.method === previous.method &&
    (current.selectionRevision ?? 0) === (previous.selectionRevision ?? 0)
  );
}
interface Dependencies {
  readStore(): ProviderAccountStore;
  updateStore(
    update: (store: ProviderAccountStore) => ProviderAccountStore,
  ): ProviderAccountStore;
  createProfile(id: string): Promise<string | undefined>;
  read(
    account: StoredProviderAccount | null,
    signal: AbortSignal,
    mode?: "cli",
  ): Promise<SubscriptionAccount>;
  login(
    account: StoredProviderAccount,
    options: LoginOptions,
  ): Promise<{
    account: SubscriptionAccount;
    credential?: StoredProviderAccount["credential"];
  }>;
  discard(account: StoredProviderAccount): Promise<void>;
  changed(): void | Promise<void>;
}

/** Account selection is native state. A login writes a new isolated profile;
 * the previous selection survives until that login has actually succeeded.
 * Only whitelisted account metadata is exposed to the renderer. */
export class ProviderAccountManager implements SubscriptionDriver {
  constructor(private readonly deps: Dependencies) {}

  private snapshot(
    account: SubscriptionAccount,
    store = this.deps.readStore(),
  ): SubscriptionAccount {
    return {
      state: account.state,
      ...(account.email ? { email: account.email } : {}),
      ...(account.plan ? { plan: account.plan } : {}),
      ...(account.organization ? { organization: account.organization } : {}),
      ...(account.expiresAtMs ? { expiresAtMs: account.expiresAtMs } : {}),
      accounts: publicProviderAccounts(store),
      activeAccountId: store.activeId,
      method: store.methodSelected ? store.method : undefined,
    };
  }

  async read(signal: AbortSignal): Promise<SubscriptionAccount> {
    const store = this.deps.readStore();
    if (store.method === "cli") {
      const account = await this.deps.read(null, signal, "cli");
      signal.throwIfAborted();
      const current = this.deps.readStore();
      return this.snapshot(
        sameSelection(current, store) ? account : { state: "disconnected" },
        current,
      );
    }
    const selected = store.accounts.find((a) => a.id === store.activeId);
    if (!selected && store.initialized)
      return this.snapshot({ state: "disconnected" }, store);
    const account = await this.deps.read(selected ?? null, signal);
    signal.throwIfAborted();
    let observedId = selected?.id;
    const next = this.deps.updateStore((current) => {
      // A newer window/operation owns the selection; don't adopt its stale probe.
      if (!sameSelection(current, store)) return current;
      if (!selected) {
        if (current.initialized) return current;
        const id = randomUUID();
        if (account.state === "connected") observedId = id;
        return account.state === "connected"
          ? {
              ...current,
              initialized: true,
              activeId: id,
              accounts: [...current.accounts, { id, ...account }],
            }
          : { ...current, initialized: true };
      }
      return {
        ...current,
        accounts: current.accounts.map((a) =>
          a.id === selected.id ? { ...a, ...account } : a,
        ),
      };
    });
    if (JSON.stringify(next) !== JSON.stringify(store))
      await this.deps.changed();
    if (
      (next.selectionRevision ?? 0) !== (store.selectionRevision ?? 0) ||
      next.method !== store.method ||
      next.activeId !== observedId
    )
      return this.snapshot(
        (next.method === "account"
          ? next.accounts.find((a) => a.id === next.activeId)
          : null) ?? { state: "disconnected" },
        next,
      );
    return this.snapshot(account, next);
  }

  async login(options: LoginOptions): Promise<SubscriptionAccount> {
    const before = this.deps.readStore();
    const existing = options.accountId
      ? before.accounts.find((account) => account.id === options.accountId)
      : undefined;
    if (options.accountId && !existing)
      throw new Error("This saved account is no longer available.");
    if (!existing && before.accounts.length >= 20)
      throw new Error(
        "Up to 20 accounts can be saved. Remove an account before adding another.",
      );
    const draft: StoredProviderAccount = {
      id: existing?.id ?? randomUUID(),
      state: "disconnected",
    };
    options.signal.throwIfAborted();
    draft.configDir =
      existing?.configDir ?? (await this.deps.createProfile(draft.id));
    let committed = false;
    try {
      options.signal.throwIfAborted();
      const { account, credential } = await this.deps.login(draft, options);
      options.signal.throwIfAborted();
      if (account.state !== "connected")
        throw new Error("Sign-in did not connect an account.");
      const saved: StoredProviderAccount = {
        ...draft,
        revision: (existing?.revision ?? 0) + 1,
        state: account.state,
        email: account.email,
        plan: account.plan,
        organization: account.organization,
        expiresAtMs: account.expiresAtMs,
        ...(credential ? { credential } : {}),
      };
      const next = this.deps.updateStore((current) => {
        if (
          existing &&
          !current.accounts.some((account) => account.id === existing.id)
        )
          throw new Error("This saved account is no longer available.");
        if (!sameSelection(current, before))
          throw new Error(
            "The selected account changed during sign-in. Try again.",
          );
        return {
          ...current,
          initialized: true,
          methodSelected: true,
          method: "account",
          activeId: draft.id,
          selectionRevision: (current.selectionRevision ?? 0) + 1,
          accounts: existing
            ? current.accounts.map((account) =>
                account.id === existing.id ? saved : account,
              )
            : [...current.accounts, saved],
        };
      });
      committed = true;
      await this.deps.changed();
      return this.snapshot(account, next);
    } finally {
      if (!committed) {
        // Preserve a saved profile on cancellation, but a concurrent removal
        // must also remove credentials written by a late native login.
        let discard = !existing?.configDir;
        if (!discard) {
          try {
            discard = !this.deps
              .readStore()
              .accounts.some((account) => account.id === draft.id);
          } catch {
            // An unreadable store is not proof that the account was removed.
          }
        }
        if (discard) await this.deps.discard(draft).catch(() => {});
      }
    }
  }

  async select(id: string, signal: AbortSignal): Promise<SubscriptionAccount> {
    const before = this.deps.readStore();
    const selected = before.accounts.find((a) => a.id === id);
    if (!selected)
      throw new Error("This saved account is no longer available.");
    const status = await this.deps.read(selected, signal);
    signal.throwIfAborted();
    const next = this.deps.updateStore((current) => {
      if (!current.accounts.some((a) => a.id === id))
        throw new Error("This saved account is no longer available.");
      if (!sameSelection(current, before))
        throw new Error(
          "The connection changed during account verification. Try again.",
        );
      return {
        ...current,
        methodSelected: true,
        method: "account",
        activeId: id,
        selectionRevision: (current.selectionRevision ?? 0) + 1,
        accounts: current.accounts.map((a) =>
          a.id === id ? { ...a, ...status } : a,
        ),
      };
    });
    await this.deps.changed();
    return this.snapshot(status, next);
  }

  async setMethod(method: ProviderAccountStore["method"]): Promise<void> {
    this.deps.updateStore((current) => ({
      ...current,
      method,
      methodSelected: true,
      selectionRevision: (current.selectionRevision ?? 0) + 1,
    }));
    await this.deps.changed();
  }

  async remove(id: string): Promise<void> {
    const selected = this.deps.readStore().accounts.find((a) => a.id === id);
    if (!selected) return;
    this.deps.updateStore((current) => ({
      ...current,
      initialized: true,
      activeId: current.activeId === id ? undefined : current.activeId,
      selectionRevision: (current.selectionRevision ?? 0) + 1,
      accounts: current.accounts.filter((a) => a.id !== id),
    }));
    await this.deps.changed();
    // Never log out the user's separately managed device CLI account.
    if (selected.configDir) await this.deps.discard(selected);
  }
}
