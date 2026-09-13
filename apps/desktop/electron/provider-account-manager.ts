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
interface Dependencies {
  readStore(): ProviderAccountStore;
  updateStore(
    update: (store: ProviderAccountStore) => ProviderAccountStore,
  ): ProviderAccountStore;
  createProfile(id: string): Promise<string | undefined>;
  read(
    account: StoredProviderAccount | null,
    signal: AbortSignal,
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
      const account = await this.deps.read(null, signal);
      signal.throwIfAborted();
      const current = this.deps.readStore();
      return this.snapshot(
        current.method === "cli" ? account : { state: "disconnected" },
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
      if (
        current.activeId !== store.activeId ||
        current.method !== store.method
      )
        return current;
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
    if (next.method !== store.method || next.activeId !== observedId)
      return this.snapshot({ state: "disconnected" }, next);
    return this.snapshot(account, next);
  }

  async login(options: LoginOptions): Promise<SubscriptionAccount> {
    const before = this.deps.readStore();
    if (before.accounts.length >= 20)
      throw new Error(
        "Up to 20 accounts can be saved. Remove an account before adding another.",
      );
    const draft: StoredProviderAccount = {
      id: randomUUID(),
      state: "disconnected",
    };
    draft.configDir = await this.deps.createProfile(draft.id);
    let committed = false;
    try {
      options.signal.throwIfAborted();
      const { account, credential } = await this.deps.login(draft, options);
      options.signal.throwIfAborted();
      if (account.state !== "connected")
        throw new Error("Sign-in did not connect an account.");
      const saved: StoredProviderAccount = {
        ...draft,
        state: account.state,
        email: account.email,
        plan: account.plan,
        organization: account.organization,
        expiresAtMs: account.expiresAtMs,
        ...(credential ? { credential } : {}),
      };
      const next = this.deps.updateStore((current) => {
        if (
          current.activeId !== before.activeId ||
          current.method !== before.method
        )
          throw new Error(
            "The selected account changed during sign-in. Try again.",
          );
        return {
          ...current,
          initialized: true,
          methodSelected: true,
          method: "account",
          activeId: draft.id,
          accounts: [...current.accounts, saved],
        };
      });
      committed = true;
      await this.deps.changed();
      return this.snapshot(account, next);
    } finally {
      if (!committed) await this.deps.discard(draft).catch(() => {});
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
      if (
        current.activeId !== before.activeId ||
        current.method !== before.method
      )
        throw new Error(
          "The connection changed during account verification. Try again.",
        );
      return {
        ...current,
        methodSelected: true,
        method: "account",
        activeId: id,
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
      accounts: current.accounts.filter((a) => a.id !== id),
    }));
    await this.deps.changed();
    // Never log out the user's separately managed device CLI account.
    if (selected.configDir) await this.deps.discard(selected);
  }
}
