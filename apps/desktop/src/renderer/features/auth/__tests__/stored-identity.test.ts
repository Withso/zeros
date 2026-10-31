import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../../platform/runtime", () => ({ isLocalDevelopment: () => false, nativeInvoke: io.invoke }));
const user = { sub: "account-a", email: "a@example.test", name: null, provider: "workos" as const };
beforeEach(() => { vi.resetModules(); io.invoke.mockReset(); });
afterEach(() => vi.restoreAllMocks());

it("reads main's stored identity before waiting for token refresh", async () => {
  const auth = await import("../auth-store");
  let finish!: (value: { access_token: string | null }) => void;
  io.invoke.mockImplementation((command: string) => command === "auth_get_session_user" ? Promise.resolve(user)
    : new Promise(resolve => { finish = resolve; }));
  const pending = auth.resync();
  await Promise.resolve();
  expect(io.invoke.mock.calls[0]?.[0]).toBe("auth_get_session_user");
  expect(auth.getStoredAuthUser()).toEqual(user);
  finish({ access_token: null });
  await pending;
  expect(auth.getStoredAuthUser()).toEqual(user);
});

it("does not publish a token read completed after sign-out", async () => {
  const auth = await import("../auth-store");
  let finish!: (value: { access_token: string | null }) => void;
  io.invoke.mockImplementation((command: string) => command === "auth_get_access_token"
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(command === "auth_get_session_user" ? user : undefined));
  const pending = auth.getSession();
  await auth.signOut("local");
  finish({ access_token: "late-fixture-session" });
  expect(await pending).toBeNull();
});

it("refuses new bearer reads while native sign-out is still settling", async () => {
  const auth = await import("../auth-store");
  let finish!: () => void;
  io.invoke.mockImplementation((command: string) => command === "auth_clear_session"
    ? new Promise<void>(resolve => { finish = resolve; })
    : Promise.resolve(command === "auth_get_session_user" ? user : { access_token: "retiring-fixture-session" }));
  const pending = auth.signOut("local");
  expect(await auth.getSession()).toBeNull();
  finish(); await pending;
});

it("does not restore a retiring identity from a resync while native sign-out is pending", async () => {
  const auth = await import("../auth-store");
  auth.markSignedIn({ ...user, access_token: "fixture-session" });
  let finish!: () => void;
  io.invoke.mockImplementation((command: string) => command === "auth_clear_session"
    ? new Promise<void>(resolve => { finish = resolve; })
    : Promise.resolve(command === "auth_get_session_user" ? user : { access_token: "retiring-fixture-session" }));
  const pending = auth.signOut("local");
  try {
    await auth.resync();
    expect(auth.getStoredAuthUser()).toBeNull();
    expect(await auth.getSession()).toBeNull();
  } finally { finish(); await pending; }
});

it("does not republish an earlier account across A → B → A token refresh", async () => {
  const auth = await import("../auth-store");
  let finish!: (value: { access_token: string }) => void;
  io.invoke.mockImplementation((command: string) => command === "auth_get_session_user" ? Promise.resolve(user)
    : new Promise(resolve => { finish = resolve; }));
  const observed: (string | null)[] = [];
  auth.onAuthStateChange(session => observed.push(session?.access_token ?? null));
  const pending = auth.resync();
  await Promise.resolve();
  auth.markSignedIn({ ...user, sub: "account-b", access_token: "fixture-b" });
  auth.markSignedIn({ ...user, access_token: "fixture-new-a" });
  finish({ access_token: "fixture-old-a" });
  await pending;
  expect(observed.filter(value => value !== null)).toEqual(["fixture-b", "fixture-new-a"]);
});

it("retires the old bearer before publishing a replacement identity with refresh pending", async () => {
  const auth = await import("../auth-store");
  auth.markSignedIn({ ...user, access_token: "fixture-a" });
  let finish!: (value: { access_token: string | null }) => void;
  io.invoke.mockImplementation((command: string) => command === "auth_get_session_user"
    ? Promise.resolve({ ...user, sub: "account-b" })
    : new Promise(resolve => { finish = resolve; }));
  const observed: string[] = [];
  auth.onAuthStateChange(session => observed.push(`session:${session?.access_token ?? null}`));
  auth.onStoredIdentityChange(identity => observed.push(`identity:${identity?.sub ?? null}`));
  const pending = auth.resync();
  await Promise.resolve();
  expect(observed).toEqual(["session:null", "identity:account-b"]);
  finish({ access_token: null });
  await pending;
});

it("discards a bearer that belongs to another account after a switch between reads", async () => {
  const auth = await import("../auth-store");
  const other = { ...user, sub: "account-b", accountId: "account-b", email: "b@example.test" };
  io.invoke.mockImplementation((command: string) => Promise.resolve(
    command === "auth_get_session_user" ? other : { access_token: "token-for-a", account: "account-a" },
  ));
  expect(await auth.getSession()).toBeNull();
  io.invoke.mockImplementation((command: string) => Promise.resolve(
    command === "auth_get_session_user" ? other : { access_token: "token-for-b", account: "account-b" },
  ));
  expect(await auth.getSession()).toEqual({ access_token: "token-for-b", user: other });
});

it("switches accounts through main and republishes the new identity", async () => {
  const auth = await import("../auth-store");
  const other = { ...user, sub: "account-b", accountId: "account-b", email: "b@example.test" };
  let current: typeof user | typeof other = user;
  io.invoke.mockImplementation((command: string, args?: { accountId?: string }) => {
    if (command === "auth_switch_account") {
      expect(args).toEqual({ accountId: "account-b" });
      current = other;
      return Promise.resolve({ status: "switched" });
    }
    if (command === "auth_get_session_user") return Promise.resolve(current);
    return Promise.resolve({ access_token: `token-for-${current.sub}`, account: current.sub });
  });
  await auth.resync();
  expect(auth.getStoredAuthUser()).toEqual(user);
  await expect(auth.switchAccount("account-b")).resolves.toBe("switched");
  expect(auth.getStoredAuthUser()).toEqual(other);
  await expect(auth.getSession()).resolves.toEqual({ access_token: "token-for-account-b", user: other });

  io.invoke.mockImplementation((command: string) => Promise.resolve(
    command === "auth_switch_account" ? { status: "unavailable" } : command === "auth_get_session_user" ? other : { access_token: "x", account: "account-b" },
  ));
  await expect(auth.switchAccount("account-a")).resolves.toBe("unavailable");
  expect(auth.getStoredAuthUser()).toEqual(other);
});
