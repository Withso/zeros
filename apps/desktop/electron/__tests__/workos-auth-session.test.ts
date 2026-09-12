import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SecretStoreReadError extends Error {}

  return {
    raw: null as string | null,
    readError: null as Error | null,
    SecretStoreReadError,
    deleteSecret: vi.fn(),
    getSecret: vi.fn(),
    network: vi.fn(),
    replaceSecretIfUnchanged: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
    setSecret: vi.fn(),
    workosConfigured: false,
  };
});

vi.mock("../secret-store", () => ({
  SecretStoreReadError: mocks.SecretStoreReadError,
  deleteSecret: mocks.deleteSecret.mockImplementation(() => {
    mocks.raw = null;
  }),
  getSecret: mocks.getSecret.mockImplementation(() => {
    if (mocks.readError) throw mocks.readError;
    return mocks.raw;
  }),
  replaceSecretIfUnchanged: mocks.replaceSecretIfUnchanged.mockImplementation(
    (_key: string, expected: string, next: string | null) => {
      if (mocks.raw !== expected) return false;
      mocks.raw = next;
      return true;
    },
  ),
  secretsFilePath: vi.fn(() => "/tmp/zeros-test-secrets.json"),
  setSecret: mocks.setSecret.mockImplementation(
    (_key: string, value: string) => {
      mocks.raw = value;
    },
  ),
}));

vi.mock("../cross-process-lock", () => ({
  withCrossProcessFileLock: vi.fn(
    async (_path: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock("../app-base-url", () => ({
  appBaseUrl: vi.fn(() => "https://app-alpha.zeros.build"),
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
  controlPlaneBaseUrl: () => "https://api-alpha.zeros.build",
}));

import { parseStoredTokenSnapshot } from "../auth-session-record";
import {
  authClearSession,
  authGetAccessToken,
  authGetSessionUser,
  authSignOutEverywhere,
  clearWorkOSSessionAfterServerRevocation,
  getValidSessionForMain,
  persistWorkOSSession,
  persistSession,
} from "../ipc/commands/auth-session";

function install(expiresAt = Date.now() + 300_000): void {
  persistWorkOSSession({
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
    mocks.readError = null;
    mocks.workosConfigured = false;
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
    install();
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
      install();
      return false;
    });
    expect(authGetSessionUser({}, {} as never)).toMatchObject({
      provider: "workos",
    });
    expect(parseStoredTokenSnapshot(mocks.raw)?.tokens.provider).toBe("workos");
  });

  it("rejects a late legacy handoff after Dev has moved to WorkOS", () => {
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    mocks.workosConfigured = true;
    install();
    const current = mocks.raw;
    expect(() => persistSession({ accessToken: "late-legacy", refreshToken: "late-refresh", sub: "auth0|legacy", email: "person@example.com", name: null })).toThrow(/WorkOS/);
    expect(mocks.raw).toBe(current);
  });

  it("returns empty renderer session reads when the whole secret store is unreadable", async () => {
    mocks.readError = new mocks.SecretStoreReadError("unreadable");

    await expect(authGetAccessToken({}, {} as never)).resolves.toEqual({
      access_token: null,
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
    install(Date.now() - 1);
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
    install();

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
    install(Date.now() - 1);
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
    install(Date.now() - 1);
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
    install(Date.now() - 1);
    mocks.refresh.mockResolvedValue({
      status: "terminal",
      reason: "invalid_grant",
    });

    await expect(getValidSessionForMain()).resolves.toBeNull();
    expect(mocks.raw).toBeNull();
  });

  it("targets current or all sessions and clears locally when revocation fails", async () => {
    mocks.revoke.mockResolvedValue(false);
    install();
    await expect(authClearSession({}, {} as never)).resolves.toBe(true);
    expect(mocks.revoke).toHaveBeenLastCalledWith("current", "access-current");
    expect(mocks.raw).toBeNull();

    install();
    await expect(authSignOutEverywhere({}, {} as never)).resolves.toBe(true);
    expect(mocks.revoke).toHaveBeenLastCalledWith("all", "access-current");
    expect(mocks.raw).toBeNull();
  });

  it("a delayed remote revocation cannot clear a replacement session", () => {
    install();
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
