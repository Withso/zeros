import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());

vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ request }),
}));

import {
  callCodexCapability,
  CodexCapabilityClientError,
} from "../codex-capabilities-client";

describe("Codex capabilities renderer client", () => {
  beforeEach(() => request.mockReset());

  it("returns the correlated typed capability result", async () => {
    request.mockResolvedValueOnce({
      type: "CODEX_CAPABILITY_RESPONSE",
      requestId: "response-1",
      operation: "account.usage.read",
      result: { planType: "plus" },
    });

    await expect(
      callCodexCapability<{ planType: string }>({
        operation: "account.usage.read",
        cwd: "/repo",
        sessionId: "zeros-session-1",
      }),
    ).resolves.toEqual({ planType: "plus" });
    expect(request).toHaveBeenCalledWith(
      {
        type: "CODEX_CAPABILITY_REQUEST",
        operation: "account.usage.read",
        cwd: "/repo",
        sessionId: "zeros-session-1",
        params: undefined,
      },
      30_000,
    );
  });

  it("surfaces correlated errors and wrong response types", async () => {
    request.mockResolvedValueOnce({
      type: "CODEX_CAPABILITY_RESPONSE",
      operation: "plugins.install",
      error: { code: "UNAVAILABLE", message: "Codex is offline" },
    });
    await expect(
      callCodexCapability({
        operation: "plugins.install",
        cwd: "/repo",
        params: { marketplacePath: "/catalog" },
      }),
    ).rejects.toBeInstanceOf(CodexCapabilityClientError);

    request.mockResolvedValueOnce({ type: "HEARTBEAT" });
    await expect(
      callCodexCapability({ operation: "skills.list", cwd: "/repo" }),
    ).rejects.toThrow(/Unexpected response/);
  });
});
