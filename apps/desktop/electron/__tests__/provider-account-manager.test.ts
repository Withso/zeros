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
    expect(f.read).toHaveBeenLastCalledWith(null, expect.any(AbortSignal));
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
