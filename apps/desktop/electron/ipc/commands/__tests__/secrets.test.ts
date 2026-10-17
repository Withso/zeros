import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  push: vi.fn(),
}));
vi.mock("../../../secret-store", () => ({
  setSecret: mocks.setSecret,
  deleteSecret: mocks.deleteSecret,
  getSecret: vi.fn(),
  hasSecret: vi.fn(),
}));
vi.mock("../../../sidecar", () => ({
  pushProviderCredentialsToEngine: mocks.push,
}));
import { keychainDelete, keychainSet } from "../secrets";

beforeEach(() => vi.resetAllMocks());

describe("provider key changes are applied before acknowledgment", () => {
  it.each(["anthropic-api-key", "openai-api-key", "cursor-api-key"])(
    "waits for the engine before confirming a saved %s",
    async (account) => {
      let applied!: () => void;
      mocks.push.mockReturnValue(
        new Promise<void>((resolve) => {
          applied = resolve;
        }),
      );
      const settled = vi.fn();
      const saving = Promise.resolve(
        keychainSet({ account, value: "fixture-key" }, {} as never),
      ).then(settled);
      await Promise.resolve();
      expect(mocks.setSecret).toHaveBeenCalledWith(account, "fixture-key");
      expect(settled).not.toHaveBeenCalled();
      applied();
      await saving;
      expect(settled).toHaveBeenCalledOnce();
    },
  );

  it("waits for a deleted key to be withdrawn from the engine", async () => {
    let applied!: () => void;
    mocks.push.mockReturnValue(
      new Promise<void>((resolve) => {
        applied = resolve;
      }),
    );
    const settled = vi.fn();
    const deleting = Promise.resolve(
      keychainDelete({ account: "cursor-api-key" }, {} as never),
    ).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    applied();
    await deleting;
    expect(mocks.deleteSecret).toHaveBeenCalledWith("cursor-api-key");
  });

  it("does not report success when the engine rejects the update", async () => {
    mocks.push.mockRejectedValue(
      new Error("The engine connection changed. Try again."),
    );
    await expect(
      keychainSet(
        { account: "cursor-api-key", value: "fixture-key" },
        {} as never,
      ),
    ).rejects.toThrow("engine connection changed");
  });
});
