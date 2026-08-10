import { describe, expect, it, vi } from "vitest";

import type { EngineMessage } from "../../../../types";
import type { TransportClient } from "../../../../transport/types";
import { CodexCapabilityBridge } from "../codex-capability-bridge";

function client(kind: "local" | "cloud" = "local") {
  const messages: EngineMessage[] = [];
  const value: TransportClient = {
    id: `${kind}-1`,
    kind,
    send: (message) => messages.push(message),
    close: vi.fn(),
  };
  return { value, messages };
}

const request = {
  type: "CODEX_CAPABILITY_REQUEST" as const,
  id: "cap-1",
  source: "browser" as const,
  timestamp: 1,
  operation: "account.usage.read" as const,
  cwd: "/repo",
  sessionId: "zeros-session-1",
};

describe("CodexCapabilityBridge", () => {
  it("returns a correlated result for a trusted desktop request", async () => {
    const invoke = vi.fn(async () => ({ planType: "plus" }));
    const bridge = new CodexCapabilityBridge(invoke);
    const target = client();

    await bridge.handle(request, target.value);

    expect(invoke).toHaveBeenCalledWith({
      operation: "account.usage.read",
      cwd: "/repo",
      sessionId: "zeros-session-1",
      params: undefined,
    });
    expect(target.messages).toEqual([
      expect.objectContaining({
        type: "CODEX_CAPABILITY_RESPONSE",
        requestId: "cap-1",
        operation: "account.usage.read",
        result: { planType: "plus" },
      }),
    ]);
  });

  it("fails closed for relay clients without invoking app-server", async () => {
    const invoke = vi.fn();
    const bridge = new CodexCapabilityBridge(invoke);
    const target = client("cloud");

    await bridge.handle(request, target.value);

    expect(invoke).not.toHaveBeenCalled();
    expect(target.messages).toEqual([
      expect.objectContaining({
        type: "CODEX_CAPABILITY_RESPONSE",
        requestId: "cap-1",
        error: expect.objectContaining({ code: "LOCAL_ONLY" }),
      }),
    ]);
  });

  it("returns bounded error semantics when the native call fails", async () => {
    const bridge = new CodexCapabilityBridge(async () => {
      throw new Error("app-server unavailable");
    });
    const target = client();

    await bridge.handle(request, target.value);

    expect(target.messages).toEqual([
      expect.objectContaining({
        type: "CODEX_CAPABILITY_RESPONSE",
        error: {
          code: "UNAVAILABLE",
          message: "app-server unavailable",
        },
      }),
    ]);
  });
});
