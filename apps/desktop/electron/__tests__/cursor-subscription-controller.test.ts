import { describe, expect, it, vi } from "vitest";
import {
  CursorSubscriptionController,
  type CursorSubscriptionCredential,
} from "../cursor-subscription-controller";
import { isRendererKeychainAccount } from "../keychain-accounts";

function fixture() {
  let stored: CursorSubscriptionCredential | null = null;
  const deps = {
    read: () => stored,
    write: vi.fn((value: CursorSubscriptionCredential | null) => {
      stored = value;
    }),
    publish: vi.fn(),
    login: vi.fn(),
    now: () => 1_000,
  };
  return { deps, controller: new CursorSubscriptionController(deps) };
}
describe("Cursor subscription authentication", () => {
  it("stores credentials privately and exposes only status and identity metadata", async () => {
    const { deps, controller } = fixture();
    deps.login.mockResolvedValue({
      apiKey: "test-secret",
      email: "user@example.test",
      apiKeyExpiresAtMs: 2_000,
    });
    const result = await controller.connect();
    expect(result).toEqual({
      state: "connected",
      email: "user@example.test",
      expiresAtMs: 2_000,
    });
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(deps.publish).toHaveBeenCalledOnce();
    expect(isRendererKeychainAccount("cursor-subscription")).toBe(false);
  });
  it("deduplicates clicks and rejects late completion after disconnect", async () => {
    const { deps, controller } = fixture();
    let finish!: (result: unknown) => void;
    deps.login.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = controller.connect();
    expect(controller.connect()).toBe(first);
    await Promise.resolve();
    controller.disconnect();
    finish({ apiKey: "stale-secret", apiKeyExpiresAtMs: 2_000 });
    await expect(first).rejects.toThrow(/canceled/);
    expect(deps.write).toHaveBeenCalledExactlyOnceWith(null);
    expect(controller.status()).toEqual({ state: "disconnected" });
  });
  it("preserves a working credential on failed replacement and scrubs provider errors", async () => {
    const { deps, controller } = fixture();
    deps.write({ apiKey: "current-secret", expiresAtMs: 2_000 });
    deps.login.mockRejectedValue(new Error("sensitive-provider-response"));
    await expect(controller.connect()).rejects.toThrow("could not finish");
    expect(controller.status().state).toBe("connected");
    deps.now = () => 3_000;
    expect(controller.status().state).toBe("expired");
  });
});
