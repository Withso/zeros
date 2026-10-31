import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SecretStoreReadError extends Error {}

  return {
    raw: null as string | null,
    // Entries other than the active session record, such as parked sessions.
    store: new Map<string, string>(),
    // Entries this device can no longer decrypt, as after a Keychain reset.
    unreadable: new Set<string>(),
    readError: null as Error | null,
    SecretStoreReadError,
    deleteSecret: vi.fn(),
    getSecret: vi.fn(),
    readSecretValues: vi.fn(),
    updateSecretValues: vi.fn(),
    network: vi.fn(),
    replaceSecretIfUnchanged: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
    setSecret: vi.fn(),
    workosConfigured: false,
    appOrigin: "https://app-alpha.zeros.build",
    apiOrigin: "https://api-alpha.zeros.build",
  };
});

vi.mock("../secret-store", () => ({
  SecretStoreReadError: mocks.SecretStoreReadError,
  deleteSecret: mocks.deleteSecret.mockImplementation((key: string = "auth-session:tokens") => {
    mocks.unreadable.delete(key);
    if (key === "auth-session:tokens") mocks.raw = null;
    else mocks.store.delete(key);
  }),
  getSecret: mocks.getSecret.mockImplementation((key: string) => {
    if (mocks.readError) throw mocks.readError;
    if (mocks.unreadable.has(key)) return null;
    return key === "auth-session:tokens" ? mocks.raw : mocks.store.get(key) ?? null;
  }),
  readSecretValues: mocks.readSecretValues.mockImplementation((keys: string[]) => {
    if (mocks.readError) throw mocks.readError;
    if (keys.some((key) => mocks.unreadable.has(key))) throw new mocks.SecretStoreReadError("unreadable");
    return Object.fromEntries(keys.map((key) => [
      key,
      key === "auth-session:tokens" ? mocks.raw : mocks.store.get(key) ?? null,
    ]));
  }),
  updateSecretValues: mocks.updateSecretValues.mockImplementation(
    (keys: string[], update: (values: Record<string, string | null>) => Record<string, string | null>) => {
      if (keys.some((key) => mocks.unreadable.has(key))) throw new mocks.SecretStoreReadError("unreadable");
      const before = Object.fromEntries(keys.map((key) => [
        key,
        key === "auth-session:tokens" ? mocks.raw : mocks.store.get(key) ?? null,
      ]));
      const next = update(before);
      for (const key of keys) {
        const value = next[key] ?? null;
        if (key === "auth-session:tokens") mocks.raw = value;
        else if (value === null) mocks.store.delete(key);
        else mocks.store.set(key, value);
      }
    },
  ),
  replaceSecretIfUnchanged: mocks.replaceSecretIfUnchanged.mockImplementation(
    (_key: string, expected: string, next: string | null) => {
      if (mocks.raw !== expected) return false;
      mocks.raw = next;
      return true;
    },
  ),
  secretsFilePath: vi.fn(() => "/tmp/zeros-test-secrets.json"),
  setSecret: mocks.setSecret.mockImplementation(
    (key: string, value: string) => {
      mocks.unreadable.delete(key);
      if (key === "auth-session:tokens") mocks.raw = value;
      else mocks.store.set(key, value);
    },
  ),
}));

vi.mock("../cross-process-lock", () => ({
  withCrossProcessFileLock: vi.fn(
    async (_path: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock("../app-base-url", () => ({
  appBaseUrl: vi.fn(() => mocks.appOrigin),
}));

vi.mock("../workos-desktop-runtime", () => ({
  workOSDesktopClientForMain: vi.fn(() => ({ refresh: mocks.refresh })),
}));

vi.mock("../workos-desktop-revocation", () => ({
  requestWorkOSDesktopRevocation: mocks.revoke,
}));

vi.mock("../workos-desktop-config", () => ({
  desktopAuthConfig: () =>
    mocks.workosConfigured
      ? {
          provider: "workos",
          desktopClientId: "client_desktop_alpha",
          issuer: "https://api.workos.com/user_management/client_web_alpha",
          jwksUrl: "https://api.workos.com/sso/jwks/client_web_alpha",
          audience: "https://api-alpha.zeros.build",
        }
      : { provider: "auth0" },
}));

vi.mock("../workos-desktop-account", () => ({
  controlPlaneBaseUrl: () => mocks.apiOrigin,
}));

import { parseParkedSessions, parseStoredTokenSnapshot } from "../auth-session-record";
import { withCrossProcessFileLock } from "../cross-process-lock";
import {
  authClearSession,
  authGetAccessToken,
  authGetSessionUser,
  authSignOutEverywhere,
  clearWorkOSSessionAfterServerRevocation,
  getValidSessionForMain,
  listSignedInAccountsForMain,
  MAX_SIGNED_IN_ACCOUNTS,
  onMainAuthSessionChanged,
  persistWorkOSSession,
  persistSession,
  switchWorkOSAccount,
} from "../ipc/commands/auth-session";

function storedWorkOS(expiresAt = Date.now() + 300_000): string {
  return JSON.stringify({
    provider: "workos",
    accessToken: "access-current",
    refreshToken: "refresh-current",
    expiresAt,
    sub: "user_example",
    email: "person@example.com",
    name: "Example Person",
    accountId: "00000000-0000-4000-8000-000000000001",
    sessionId: "session_example",
    clientKind: "desktop",
    authenticationMethod: "GoogleOAuth",
  });
}

async function install(expiresAt = Date.now() + 300_000): Promise<void> {
  await persistWorkOSSession({
    accessToken: "access-current",
    refreshToken: "refresh-current",
    expiresAt,
    providerSubject: "user_example",
    sessionId: "session_example",
    clientKind: "desktop",
    email: "person@example.com",
    name: "Example Person",
    authenticationMethod: "GoogleOAuth",
    accountId: "00000000-0000-4000-8000-000000000001",
  });
}

describe("WorkOS desktop safe-storage session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.raw = null;
    mocks.store.clear();
    mocks.unreadable.clear();
    mocks.readError = null;
    mocks.workosConfigured = false;
    mocks.appOrigin = "https://app-alpha.zeros.build";
    mocks.apiOrigin = "https://api-alpha.zeros.build";
    mocks.network.mockReset();
    vi.stubGlobal("fetch", mocks.network);
    mocks.refresh.mockReset();
    mocks.revoke.mockReset();
    mocks.revoke.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("revokes a managed Auth0 device handle on local sign-out and retains a newer login", async () => {
    persistSession({ accessToken: "current", refreshToken: `z0d_${"A".repeat(43)}`, sub: "auth0|old", email: "old@example.test", name: null });
    mocks.network.mockImplementation(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toMatchObject({ scope: "current", refresh_token: `z0d_${"A".repeat(43)}` });
      persistSession({ accessToken: "new-login", refreshToken: `z0d_${"B".repeat(43)}`, sub: "auth0|new", email: "new@example.test", name: null });
      return Response.json({ ok: true });
    });
    await authClearSession({}, {} as never);
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens.sub).toBe("auth0|new");
  });

  it("uses a hosted workspace's isolated WorkOS contract during session migration", () => {
    const owner = "a".repeat(24);
    mocks.appOrigin = `https://app-dev-${owner}.example.test`;
    mocks.apiOrigin = `https://api-dev-${owner}.example.test`;
    mocks.workosConfigured = true;
    vi.stubEnv("ZEROS_CHANNEL", "dev"); vi.stubEnv("ZEROS_ISOLATE", "1"); vi.stubEnv("ZEROS_DEV_ENVIRONMENT", "hosted");
    vi.stubEnv("ZEROS_DEV_AUTH_PROFILE", JSON.stringify({ version: 1, owner, domain: "example.test", authEnvironment: "alpha",
      webClientId: "client_web_alpha", desktopClientId: "client_desktop_alpha", audience: "https://api-alpha.zeros.build",
      appOrigin: mocks.appOrigin, apiOrigin: mocks.apiOrigin, issuer: "https://api.workos.com/user_management/client_web_alpha",
      jwksUrl: "https://api.workos.com/sso/jwks/client_web_alpha" }));
    mocks.raw = JSON.stringify({ provider: "auth0", accessToken: "legacy-access", refreshToken: "legacy-refresh",
      expiresAt: Date.now() + 300_000, sub: "auth0|legacy", email: "person@example.com", name: null });
    expect(authGetSessionUser({}, {} as never)).toBeNull();
    expect(mocks.raw).toBeNull(); expect(mocks.network).not.toHaveBeenCalled();
  });

  it("retires a legacy Dev session once after Alpha WorkOS is configured, without calling the old refresh endpoint", async () => {
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    mocks.workosConfigured = true;
    mocks.raw = JSON.stringify({
      provider: "auth0",
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      expiresAt: Date.now() + 300_000,
      sub: "auth0|legacy",
      email: "person@example.com",
      name: null,
    });
    expect(authGetSessionUser({}, {} as never)).toBeNull();
    await expect(getValidSessionForMain()).resolves.toBeNull();
    expect(mocks.raw).toBeNull();
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.replaceSecretIfUnchanged).toHaveBeenCalledTimes(1);
    await install();
    await expect(getValidSessionForMain()).resolves.toMatchObject({
      provider: "workos",
    });
    expect(mocks.raw).not.toBeNull();
  });

  it("preserves release Auth0 rollback sessions and unconfigured Dev sessions", () => {
    const legacy = JSON.stringify({
      provider: "auth0",
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      expiresAt: Date.now() + 300_000,
      sub: "auth0|legacy",
      email: "person@example.com",
      name: null,
    });
    mocks.raw = legacy;
    vi.stubEnv("ZEROS_CHANNEL", "alpha");
    mocks.workosConfigured = true;
    expect(authGetSessionUser({}, {} as never)).not.toBeNull();
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    mocks.workosConfigured = false;
    expect(authGetSessionUser({}, {} as never)).not.toBeNull();
    expect(mocks.raw).toBe(legacy);
  });

  it("a migration cannot erase the WorkOS session a sibling just installed", () => {
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    mocks.workosConfigured = true;
    mocks.raw = JSON.stringify({
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      expiresAt: 1,
      sub: "auth0|legacy",
      email: "person@example.com",
      name: null,
    });
    mocks.replaceSecretIfUnchanged.mockImplementationOnce(() => {
      mocks.raw = storedWorkOS();
      return false;
    });
    expect(authGetSessionUser({}, {} as never)).toMatchObject({
      provider: "workos",
    });
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens.provider).toBe("workos");
  });

  it("rejects a late legacy handoff after Dev has moved to WorkOS", async () => {
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    mocks.workosConfigured = true;
    await install();
    const current = mocks.raw;
    expect(() => persistSession({ accessToken: "late-legacy", refreshToken: "late-refresh", sub: "auth0|legacy", email: "person@example.com", name: null })).toThrow(/WorkOS/);
    expect(mocks.raw).toBe(current);
  });

  it("returns empty renderer session reads when the whole secret store is unreadable", async () => {
    mocks.readError = new mocks.SecretStoreReadError("unreadable");

    await expect(authGetAccessToken({}, {} as never)).resolves.toEqual({
      access_token: null,
      account: null,
    });
    expect(authGetSessionUser({}, {} as never)).toBeNull();
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.deleteSecret).not.toHaveBeenCalled();
    expect(mocks.replaceSecretIfUnchanged).not.toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
  });

  it("does not hide unexpected renderer session read failures", async () => {
    const unexpected = new Error("unexpected read failure");
    mocks.readError = unexpected;

    await expect(authGetAccessToken({}, {} as never)).rejects.toBe(unexpected);
    expect(() => authGetSessionUser({}, {} as never)).toThrow(unexpected);
  });

  it("keeps refresh persistence failures fail-closed", async () => {
    await install(Date.now() - 1);
    mocks.refresh.mockResolvedValue({
      status: "active",
      session: {
        accessToken: "access-next",
        refreshToken: "refresh-next",
        expiresAt: Date.now() + 300_000,
        providerSubject: "user_example",
        sessionId: "session_example",
        clientKind: "desktop",
        email: "person@example.com",
        name: "Example Person",
        authenticationMethod: "GoogleOAuth",
      },
    });
    const mutationError = new mocks.SecretStoreReadError("mutation failed");
    mocks.replaceSecretIfUnchanged.mockImplementationOnce(() => {
      throw mutationError;
    });

    await expect(authGetAccessToken({}, {} as never)).rejects.toBe(
      mutationError,
    );
  });

  it("stores the provider session with its internal product owner", async () => {
    await install();

    await expect(getValidSessionForMain()).resolves.toMatchObject({
      provider: "workos",
      accountId: "00000000-0000-4000-8000-000000000001",
      sessionId: "session_example",
      clientKind: "desktop",
      accessToken: "access-current",
    });
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens).toMatchObject({
      provider: "workos",
      refreshToken: "refresh-current",
      accountId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("serially installs every successful rotated refresh response", async () => {
    await install(Date.now() - 1);
    mocks.refresh.mockResolvedValue({
      status: "active",
      session: {
        accessToken: "access-next",
        refreshToken: "refresh-next",
        expiresAt: Date.now() + 300_000,
        providerSubject: "user_example",
        sessionId: "session_example",
        clientKind: "desktop",
        email: "new@example.com",
        name: "New Name",
        authenticationMethod: "GitHubOAuth",
      },
    });

    await expect(getValidSessionForMain()).resolves.toMatchObject({
      accessToken: "access-next",
      email: "new@example.com",
    });
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens).toMatchObject({
      accessToken: "access-next",
      refreshToken: "refresh-next",
      authenticationMethod: "GitHubOAuth",
    });
    expect(mocks.refresh).toHaveBeenCalledWith({
      refreshToken: "refresh-current",
      expectedSubject: "user_example",
      expectedSessionId: "session_example",
    });
  });

  it("keeps a post-rotation replacement but withholds an expired bearer", async () => {
    await install(Date.now() - 1);
    mocks.refresh.mockResolvedValue({
      status: "transient",
      reason: "verification_unavailable",
      replacementRefreshToken: "refresh-next",
    });

    await expect(getValidSessionForMain()).resolves.toBeNull();
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens).toMatchObject({
      accessToken: "access-current",
      refreshToken: "refresh-next",
    });
  });

  it("clears safe storage only for an explicit terminal grant rejection", async () => {
    await install(Date.now() - 1);
    mocks.refresh.mockResolvedValue({
      status: "terminal",
      reason: "invalid_grant",
    });

    await expect(getValidSessionForMain()).resolves.toBeNull();
    expect(mocks.raw).toBeNull();
  });

  it("targets current or all sessions and clears locally when revocation fails", async () => {
    mocks.revoke.mockResolvedValue(false);
    await install();
    await expect(authClearSession({}, {} as never)).resolves.toBe(true);
    expect(mocks.revoke).toHaveBeenLastCalledWith("current", "access-current", expect.any(Function));
    expect(mocks.raw).toBeNull();

    await install();
    await expect(authSignOutEverywhere({}, {} as never)).rejects.toThrow(/other devices/);
    expect(mocks.revoke).toHaveBeenLastCalledWith("all", "access-current", expect.any(Function));
    expect(mocks.raw).toBeNull();
  });

  it("a delayed remote revocation cannot clear a replacement session", async () => {
    await install();
    expect(
      clearWorkOSSessionAfterServerRevocation({
        accountId: "00000000-0000-4000-8000-000000000001",
        sessionId: "session_other",
      }),
    ).toBe(false);
    expect(mocks.raw).not.toBeNull();

    expect(
      clearWorkOSSessionAfterServerRevocation({
        accountId: "00000000-0000-4000-8000-000000000001",
        sessionId: "session_example",
      }),
    ).toBe(true);
    expect(mocks.raw).toBeNull();
  });
});

describe("WorkOS desktop multi-account sessions", () => {
  const account = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  async function signIn(n: number, options: { expiresAt?: number; session?: string } = {}) {
    await persistWorkOSSession({
      accessToken: `access-${n}`,
      refreshToken: `refresh-${n}`,
      expiresAt: options.expiresAt ?? Date.now() + 300_000,
      providerSubject: `user_${n}`,
      sessionId: options.session ?? `session_${n}`,
      clientKind: "desktop",
      email: `user-${n}@example.test`,
      name: null,
      authenticationMethod: "Password",
      accountId: account(n),
    });
  }
  const activeEmail = () => parseStoredTokenSnapshot(mocks.raw)?.tokens.email ?? null;
  const signedIn = () => listSignedInAccountsForMain().map((entry) => `${entry.email}${entry.active ? " (active)" : ""}`);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.raw = null;
    mocks.store.clear();
    mocks.unreadable.clear();
    mocks.readError = null;
    mocks.workosConfigured = false;
    mocks.refresh.mockReset();
    mocks.revoke.mockReset();
    mocks.revoke.mockResolvedValue(true);
  });

  it("parks the signed-in account when another one signs in, and lists both without tokens", async () => {
    await signIn(1);
    await signIn(2);
    expect(activeEmail()).toBe("user-2@example.test");
    expect(signedIn()).toEqual(["user-2@example.test (active)", "user-1@example.test"]);
    expect(JSON.stringify(listSignedInAccountsForMain())).not.toMatch(/access-|refresh-/);
    expect(mocks.revoke).not.toHaveBeenCalled();
    // The same account signing in again replaces its own session and revokes it.
    await signIn(2, { session: "session_2b" });
    expect(signedIn()).toEqual(["user-2@example.test (active)", "user-1@example.test"]);
    await vi.waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("current", "access-2", expect.anything()));
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens).toMatchObject({ sessionId: "session_2b" });
  });

  it("switches in one write and back again, keeping both sessions", async () => {
    await signIn(1);
    await signIn(2);
    const changed = vi.fn();
    const off = onMainAuthSessionChanged(changed);
    try {
      mocks.updateSecretValues.mockClear();
      await expect(switchWorkOSAccount(account(1))).resolves.toBe("switched");
      // Active and parked sessions move in one transaction.
      expect(mocks.updateSecretValues).toHaveBeenCalledTimes(1);
      expect(signedIn()).toEqual(["user-1@example.test (active)", "user-2@example.test"]);
      await expect(switchWorkOSAccount(account(2))).resolves.toBe("switched");
      expect(signedIn()).toEqual(["user-2@example.test (active)", "user-1@example.test"]);
      await expect(switchWorkOSAccount(account(2))).resolves.toBe("current");
      await expect(switchWorkOSAccount(account(9))).resolves.toBe("missing");
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
    expect(mocks.refresh).not.toHaveBeenCalled();
    await expect(authGetAccessToken({}, {} as never)).resolves.toEqual({
      access_token: "access-2",
      account: account(2),
    });
  });

  it("refreshes an expiring account before switching to it", async () => {
    await signIn(1, { expiresAt: Date.now() - 1 });
    await signIn(2);
    mocks.refresh.mockResolvedValue({
      status: "active",
      session: {
        accessToken: "access-1-next",
        refreshToken: "refresh-1-next",
        expiresAt: Date.now() + 300_000,
        providerSubject: "user_1",
        sessionId: "session_1",
        clientKind: "desktop",
        email: "user-1@example.test",
        name: null,
        authenticationMethod: "Password",
      },
    });
    await expect(switchWorkOSAccount(account(1))).resolves.toBe("switched");
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "refresh-1" }));
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens).toMatchObject({
      accessToken: "access-1-next",
      refreshToken: "refresh-1-next",
    });
  });

  it("drops only a rejected account and never signs out the one in use", async () => {
    await signIn(1, { expiresAt: Date.now() - 1 });
    await signIn(2);
    mocks.refresh.mockResolvedValue({ status: "terminal" });
    await expect(switchWorkOSAccount(account(1))).resolves.toBe("signed_out");
    expect(signedIn()).toEqual(["user-2@example.test (active)"]);

    await signIn(3, { expiresAt: Date.now() - 1 });
    await signIn(2);
    mocks.refresh.mockResolvedValue({ status: "transient", replacementRefreshToken: "refresh-3-rotated" });
    await expect(switchWorkOSAccount(account(3))).resolves.toBe("unavailable");
    expect(activeEmail()).toBe("user-2@example.test");
    // A rotated refresh token survives the failed switch.
    mocks.refresh.mockResolvedValue({ status: "terminal" });
    await switchWorkOSAccount(account(3));
    expect(mocks.refresh).toHaveBeenLastCalledWith(expect.objectContaining({ refreshToken: "refresh-3-rotated" }));
  });

  it("continues with the most recent other account after signing out, and signs out one account alone", async () => {
    await signIn(1);
    await signIn(2);
    await signIn(3);
    await authClearSession({}, {} as never);
    expect(mocks.revoke).toHaveBeenCalledWith("current", "access-3", expect.anything());
    expect(signedIn()).toEqual(["user-2@example.test (active)", "user-1@example.test"]);

    await authClearSession({ accountId: account(1) }, {} as never);
    expect(mocks.revoke).toHaveBeenLastCalledWith("current", "access-1", expect.anything());
    expect(signedIn()).toEqual(["user-2@example.test (active)"]);
  });

  it("keeps the most recent accounts within the device limit and revokes the oldest", async () => {
    for (let n = 1; n <= MAX_SIGNED_IN_ACCOUNTS + 1; n++) await signIn(n);
    const accounts = listSignedInAccountsForMain();
    expect(accounts).toHaveLength(MAX_SIGNED_IN_ACCOUNTS);
    expect(accounts.map((entry) => entry.email)).not.toContain("user-1@example.test");
    await vi.waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("current", "access-1", expect.anything()));
  });

  it("never lets an entry this device can no longer decrypt block a new sign-in", async () => {
    await signIn(1);
    await signIn(2);
    mocks.unreadable.add("auth-session:tokens");
    mocks.unreadable.add("auth-session:parked");
    await signIn(3);
    expect(activeEmail()).toBe("user-3@example.test");
    expect(signedIn()).toEqual(["user-3@example.test (active)"]);
    // A switch is unaffected once the unreadable entries are replaced.
    await signIn(4);
    await expect(switchWorkOSAccount(account(3))).resolves.toBe("switched");
  });

  it("never promotes another account after the server revokes the active one", async () => {
    await signIn(1);
    await signIn(2);
    expect(clearWorkOSSessionAfterServerRevocation({ accountId: account(2), sessionId: "session_2" })).toBe(true);
    expect(mocks.raw).toBeNull();
    expect(signedIn()).toEqual(["user-1@example.test"]);
  });

  it("continues with the next account after signing out everywhere, unless one signed in meanwhile", async () => {
    await signIn(1);
    await signIn(2);
    await authSignOutEverywhere({}, {} as never);
    expect(mocks.revoke).toHaveBeenCalledWith("all", "access-2", expect.anything());
    expect(signedIn()).toEqual(["user-1@example.test (active)"]);
    await expect(switchWorkOSAccount(account(9), { onlyIfSignedOut: true })).resolves.toBe("current");
  });

  it("waits for a refresh of the active session before parking it", async () => {
    // A real mutex in place of the pass-through cross-process lock.
    let tail: Promise<unknown> = Promise.resolve();
    vi.mocked(withCrossProcessFileLock).mockImplementation(async (_path, operation) => {
      const run = tail.then(() => operation());
      tail = run.catch(() => undefined);
      return run as never;
    });
    try {
      await signIn(1);
      await signIn(2, { expiresAt: Date.now() - 1 });
      let finish!: () => void;
      mocks.refresh.mockImplementation(() => new Promise((resolve) => {
        finish = () => resolve({
          status: "active",
          session: {
            accessToken: "access-2-next", refreshToken: "refresh-2-next", expiresAt: Date.now() + 300_000,
            providerSubject: "user_2", sessionId: "session_2", clientKind: "desktop",
            email: "user-2@example.test", name: null, authenticationMethod: "Password",
          },
        });
      }));
      const reading = getValidSessionForMain();
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
      const switching = switchWorkOSAccount(account(1));
      finish();
      await reading;
      await expect(switching).resolves.toBe("switched");
      // The rotated refresh token is the one parked; the stale one would be dead.
      expect(parseParkedSessions(mocks.store.get("auth-session:parked") ?? null).get(account(2))?.tokens)
        .toMatchObject({ refreshToken: "refresh-2-next" });
    } finally {
      vi.mocked(withCrossProcessFileLock).mockImplementation(async (_path, operation) => operation());
    }
  });
});
