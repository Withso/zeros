import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  raw: null as string | null,
  refresh: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("../secret-store", () => ({
  deleteSecret: vi.fn(() => {
    mocks.raw = null;
  }),
  getSecret: vi.fn(() => mocks.raw),
  replaceSecretIfUnchanged: vi.fn(
    (_key: string, expected: string, next: string | null) => {
      if (mocks.raw !== expected) return false;
      mocks.raw = next;
      return true;
    },
  ),
  secretsFilePath: vi.fn(() => "/tmp/zeros-test-secrets.json"),
  setSecret: vi.fn((_key: string, value: string) => {
    mocks.raw = value;
  }),
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

import { parseStoredTokenSnapshot } from "../auth-session-record";
import {
  authClearSession,
  authSignOutEverywhere,
  getValidSessionForMain,
  persistWorkOSSession,
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
    mocks.raw = null;
    mocks.refresh.mockReset();
    mocks.revoke.mockReset();
    mocks.revoke.mockResolvedValue(true);
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
});
