import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
const deps = vi.hoisted(() => ({
  read: vi.fn().mockResolvedValue({ state: "disconnected" }),
  login: vi.fn().mockResolvedValue({ state: "connected" }),
  emit: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/fixture/native" },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../../sidecar", () => ({
  resolveClaudeCliPaths: () => ({ binary: null }),
  resolveCodexCliPaths: () => ({ binary: null }),
  pushProviderCredentialsToEngine: vi.fn(),
}));
vi.mock("../../../provider-account-store", () => ({
  readProviderAccounts: () => ({ version: 1, method: "account", initialized: true, accounts: [] }),
  updateProviderAccounts: vi.fn(),
  publicProviderAccounts: () => [],
}));
vi.mock("../../../provider-subscription-drivers", () => ({
  createSubscriptionDriver: () => ({ read: deps.read, login: deps.login }),
  subscriptionEnvironment: () => ({}),
}));
vi.mock("../../events", () => ({ emitEvent: deps.emit }));
vi.mock("../cursor-subscription", () => ({
  cursorSubscriptionController: {
    status: () => ({ state: "disconnected" }),
    cancel: vi.fn(),
  },
}));
import {
  providerSubscription,
  stopProviderSubscriptions,
} from "../provider-subscription";
const event = {} as IpcMainInvokeEvent;
afterEach(async () => {
  await stopProviderSubscriptions();
});

describe("native subscription IPC boundary", () => {
  it("rejects executable, environment, URL, and workspace injection without echoing values", () => {
    for (const extra of [
      { executable: "/untrusted" },
      { env: { HOME: "/untrusted" } },
      { url: "https://untrusted.test" },
      { cwd: "/untrusted" },
    ]) {
      expect(() =>
        providerSubscription(
          { provider: "claude", action: "connect", ...extra },
          event,
        ),
      ).toThrow("Invalid subscription connection request.");
    }
    expect(deps.login).not.toHaveBeenCalled();
  });
  it("requires matching attempts and rejects control characters or codes for other providers", () => {
    const attemptId = "00000000-0000-4000-8000-000000000001";
    for (const args of [
      { provider: "codex", action: "submit-code", attemptId, code: "sample" },
      {
        provider: "claude",
        action: "submit-code",
        attemptId,
        code: "sample\nnext-command",
      },
      { provider: "claude", action: "cancel" },
      { provider: "unknown", action: "connect" },
    ])
      expect(() => providerSubscription(args, event)).toThrow(
        "Invalid subscription connection request.",
      );
  });
  it("returns only native status and never starts an agent for a status request", async () => {
    expect(
      await providerSubscription(
        { provider: "codex", action: "status" },
        event,
      ),
    ).toMatchObject({ provider: "codex", state: "disconnected" });
    expect(deps.login).not.toHaveBeenCalled();
  });
});
