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
    persistSession: vi.fn(),
    setSecret: vi.fn(),
  };
});

vi.mock("../secret-store", () => ({
  SecretStoreReadError: mocks.SecretStoreReadError,
  deleteSecret: mocks.deleteSecret,
  getSecret: mocks.getSecret,
  setSecret: mocks.setSecret,
}));

vi.mock("../ipc/commands/auth-session", () => ({
  persistSession: mocks.persistSession,
}));

vi.mock("../app-base-url", () => ({
  appBaseUrl: vi.fn(() => "https://app-alpha.zeros.build"),
}));

import {
  authPeekHandoff,
  authRedeemHandoff,
} from "../ipc/commands/auth-handoff";

describe("auth handoff secret-store read boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.raw = null;
    mocks.readError = null;
    mocks.getSecret.mockImplementation(() => {
      if (mocks.readError) throw mocks.readError;
      return mocks.raw;
    });
    mocks.deleteSecret.mockImplementation(() => {
      mocks.raw = null;
    });
    mocks.network.mockReset();
    vi.stubGlobal("fetch", mocks.network);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns no pending handoff when the whole secret store is unreadable", async () => {
    mocks.readError = new mocks.SecretStoreReadError("unreadable");

    expect(authPeekHandoff({}, {} as never)).toEqual({
      nonce: null,
      expiresAt: null,
    });
    await expect(
      authRedeemHandoff(
        { ticket: "opaque-ticket", nonce: "expected-nonce" },
        {} as never,
      ),
    ).resolves.toEqual({ error: "no_pending_handoff" });
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.deleteSecret).not.toHaveBeenCalled();
    expect(mocks.persistSession).not.toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
  });

  it("does not hide unexpected handoff read failures", async () => {
    const unexpected = new Error("unexpected read failure");
    mocks.readError = unexpected;

    expect(() => authPeekHandoff({}, {} as never)).toThrow(unexpected);
    await expect(
      authRedeemHandoff(
        { ticket: "opaque-ticket", nonce: "expected-nonce" },
        {} as never,
      ),
    ).rejects.toBe(unexpected);
  });

  it("keeps mutation failures fail-closed after a successful read", async () => {
    mocks.raw = JSON.stringify({
      nonce: "expected-nonce",
      verifier: "expected-verifier",
    });
    const mutationError = new mocks.SecretStoreReadError("mutation failed");
    mocks.deleteSecret.mockImplementationOnce(() => {
      throw mutationError;
    });

    await expect(
      authRedeemHandoff(
        { ticket: "opaque-ticket", nonce: "expected-nonce" },
        {} as never,
      ),
    ).rejects.toBe(mutationError);
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.persistSession).not.toHaveBeenCalled();
  });
});
