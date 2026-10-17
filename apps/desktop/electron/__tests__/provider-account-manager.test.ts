import { describe, expect, it, vi } from "vitest";
import { ProviderAccountManager } from "../provider-account-manager";
import type {
  ProviderAccountStore,
  StoredProviderAccount,
} from "../provider-account-store";

function fixture() {
  let store: ProviderAccountStore = {
    version: 1,
    method: "account",
    initialized: true,
    accounts: [],
  };
  const read = vi.fn(async (a: StoredProviderAccount | null) => ({
    state: "connected" as const,
    email: a?.email ?? "device@example.test",
  }));
  const login = vi.fn(async () => ({
    account: { state: "connected" as const, email: "added@example.test" },
    credential: { apiKey: "fixture-private-key", expiresAtMs: 9999999999999 },
  }));
  const discard = vi.fn(async (_account: StoredProviderAccount) => {});
  const manager = new ProviderAccountManager({
    readStore: () => store,
    updateStore: (fn) => (store = fn(store)),
    createProfile: async (id) => `/private/profiles/${id}`,
    read,
    login,
    discard,
    changed: vi.fn(),
  });
  return { manager, read, login, discard, store: () => store };
}
const signal = () => new AbortController().signal;
const options = () => ({ signal: signal(), onCodeRequired: vi.fn() });
describe("saved subscription accounts", () => {
  it("reads the existing CLI authentication without replacing or relabeling a saved account", async () => {
    const f = fixture();
    await f.manager.login(options());
    const saved = structuredClone(f.store().accounts);
    const logins = f.login.mock.calls.length;
    await f.manager.setMethod("cli");
    const status = await f.manager.read(signal());
    expect(status).toMatchObject({ state: "connected", method: "cli", email: "device@example.test" });
    expect(f.read).toHaveBeenLastCalledWith(null, expect.any(AbortSignal), "cli");
    expect(f.store().accounts).toEqual(saved);
    expect(f.login).toHaveBeenCalledTimes(logins);
  });
  it("does not publish saved-account identity as a newer CLI connection", async () => {
    const f = fixture();
    await f.manager.login(options());
    let finish!: (value: { state: "connected"; email: string }) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = f.manager.read(signal());
    await f.manager.setMethod("cli");
    finish({ state: "connected", email: "saved@example.test" });
    const result = await reading;
    expect(result.method).toBe("cli");
    expect(result.state).toBe("disconnected");
    expect(result.email).toBeUndefined();
  });

  it("fences a stale account probe across A → B → A selection", async () => {
    const f = fixture();
    const a = await f.manager.login(options());
    const b = await f.manager.login(options());
    await f.manager.select(a.activeAccountId!, signal());
    let finish!: (value: { state: "connected"; email: string }) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const oldRead = f.manager.read(signal());
    await f.manager.select(b.activeAccountId!, signal());
    await f.manager.select(a.activeAccountId!, signal());
    finish({ state: "connected", email: "stale@example.test" });
    await oldRead;
    expect(f.store().accounts.find(account => account.id === a.activeAccountId)?.email).toBe("added@example.test");
  });

  it("reauthenticates a saved account without duplicating it or changing its native profile", async () => {
    const f = fixture();
    const first = await f.manager.login(options());
    const saved = f.store().accounts[0];
    await f.manager.login(options());
    const result = await f.manager.login({ ...options(), accountId: first.activeAccountId! });
    expect(result.activeAccountId).toBe(first.activeAccountId);
    expect(f.store().accounts).toHaveLength(2);
    expect(f.login).toHaveBeenLastCalledWith(expect.objectContaining({
      id: saved.id, configDir: saved.configDir,
    }), expect.anything());
    expect(f.store().accounts[0]).toMatchObject({ revision: 2 });
  });

  it("keeps a saved profile and the working selection when reauthentication is canceled", async () => {
    const f = fixture();
    const a = await f.manager.login(options());
    const b = await f.manager.login(options());
    f.login.mockRejectedValueOnce(new Error("canceled"));
    await expect(f.manager.login({ ...options(), accountId: a.activeAccountId! })).rejects.toThrow("canceled");
    expect(f.store().activeId).toBe(b.activeAccountId);
    expect(f.store().accounts).toHaveLength(2);
    expect(f.discard).not.toHaveBeenCalled();
  });

  it("rejects reauthentication of an account removed during the ceremony", async () => {
    const f = fixture();
    const a = await f.manager.login(options());
    const b = await f.manager.login(options());
    let finish!: (value: Awaited<ReturnType<typeof f.login>>) => void;
    f.login.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const signingIn = f.manager.login({ ...options(), accountId: a.activeAccountId! });
    await vi.waitFor(() => expect(f.login).toHaveBeenCalledTimes(3));
    await f.manager.remove(a.activeAccountId!);
    finish({ account: { state: "connected", email: "added@example.test" }, credential: { apiKey: "renewed-fixture-key", expiresAtMs: 9999999999999 } });
    await expect(signingIn).rejects.toThrow("no longer available");
    expect(f.store().activeId).toBe(b.activeAccountId);
    expect(f.store().accounts).toHaveLength(1);
    // Native OAuth may have written again after the earlier logout completed.
    expect(f.discard).toHaveBeenCalledTimes(2);
    expect(f.discard).toHaveBeenLastCalledWith(expect.objectContaining({ id: a.activeAccountId }));
  });

  it("creates isolated accounts and really reads the selected profile when switching A → B → A", async () => {
    const f = fixture();
    const a = await f.manager.login(options());
    const b = await f.manager.login(options());
    expect(a.activeAccountId).not.toBe(b.activeAccountId);
    expect(f.store().accounts[0].configDir).not.toBe(
      f.store().accounts[1].configDir,
    );
    await f.manager.select(a.activeAccountId!, signal());
    expect(f.read).toHaveBeenLastCalledWith(
      f.store().accounts[0],
      expect.any(AbortSignal),
    );
    expect((await f.manager.read(signal())).activeAccountId).toBe(
      a.activeAccountId,
    );
    expect(JSON.stringify(a)).not.toMatch(
      /fixture-private-key|configDir|credential/,
    );
    f.manager.setMethod("cli");
    await f.manager.read(signal());
    expect(f.read).toHaveBeenLastCalledWith(null, expect.any(AbortSignal), "cli");
    f.manager.setMethod("account");
    expect((await f.manager.read(signal())).activeAccountId).toBe(
      a.activeAccountId,
    );
  });
  it("does not claim a selected but unconfigured method is authenticated", async () => {
    const f = fixture();
    expect((await f.manager.read(signal())).state).toBe("disconnected");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("keeps the current account after cancellation or failure and discards only the draft", async () => {
    const f = fixture();
    const a = await f.manager.login(options());
    f.login.mockRejectedValueOnce(new Error("failed"));
    await expect(f.manager.login(options())).rejects.toThrow("failed");
    expect(f.store().activeId).toBe(a.activeAccountId);
    expect(f.store().accounts).toHaveLength(1);
    expect(f.discard).toHaveBeenCalledOnce();
    expect(f.discard.mock.calls[0][0].id).not.toBe(a.activeAccountId);
  });
  it("rejects an account removed during verification instead of falling back to another account", async () => {
    const f = fixture();
    const a = await f.manager.login(options());
    let finish!: (value: { state: "connected"; email: string }) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const selecting = f.manager.select(a.activeAccountId!, signal());
    await f.manager.remove(a.activeAccountId!);
    finish({ state: "connected", email: "removed@example.test" });
    await expect(selecting).rejects.toThrow("no longer available");
    expect(f.store().activeId).toBeUndefined();
    expect((await f.manager.read(signal())).state).toBe("disconnected");
  });
  it("does not overwrite a newer method selection with a slow account verification", async () => {
    const f = fixture();
    const a = await f.manager.login(options());
    await f.manager.login(options());
    let finish!: (value: { state: "connected"; email: string }) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const selecting = f.manager.select(a.activeAccountId!, signal());
    await f.manager.setMethod("cli");
    finish({ state: "connected", email: "earlier@example.test" });
    await expect(selecting).rejects.toThrow("changed");
    expect(f.store().method).toBe("cli");
  });
  it("cannot label the saved account connected using a late device CLI result", async () => {
    const f = fixture();
    await f.manager.login(options());
    await f.manager.setMethod("cli");
    let finish!: (value: { state: "connected"; email: string }) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = f.manager.read(signal());
    await f.manager.setMethod("account");
    finish({ state: "connected", email: "other-device-account@example.test" });
    const result = await reading;
    expect(result.state).toBe("disconnected");
    expect(result.email).toBeUndefined();
  });
});
