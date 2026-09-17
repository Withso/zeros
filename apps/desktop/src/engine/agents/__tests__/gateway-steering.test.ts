import { describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";

describe("gateway steering admission", () => {
  it("rechecks the accepting turn after startup admission before resolving an adapter", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapterForSession = vi.fn(() => {
      throw new Error("stale adapter must not be used");
    });
    const context = {
      awaitAdapterStartupSettled: () => gate,
      adapterForSession,
    };
    let current = true;
    const receipt = Reflect.apply(AgentGateway.prototype.steer, context, [
      "claude",
      "execution",
      [{ type: "text", text: "C" }],
      () => current,
    ]);
    const result = expect(receipt).resolves.toBe("queued");
    current = false;
    release();
    await result;
    expect(adapterForSession).not.toHaveBeenCalled();
  });
});
