import { describe, expect, it, vi } from "vitest";
import { bridgeChatSwitchAgent } from "../workspace-bridge";
import type { RuntimeClient } from "../ws-client";

const input = { chatId: "chat", fromAgentId: "claude", agentId: "codex", model: "gpt-5", effort: "", fast: false,
  message: { msgId: "switch", kind: "tool", payload: "{}", createdAt: 1 } };
const bridgeReturning = (response: unknown) => {
  const request = vi.fn(async () => response);
  return { request, bridge: { request } as unknown as RuntimeClient };
};

describe("bridgeChatSwitchAgent", () => {
  it("sends one explicit worker switch with the switch row", async () => {
    const { request, bridge } = bridgeReturning({ type: "WORKSPACE_RESPONSE", op: "chats.switchAgent", result: { ok: true } });
    await expect(bridgeChatSwitchAgent(bridge, input)).resolves.toBe("switched");
    expect(request).toHaveBeenCalledWith({ type: "WORKSPACE_REQUEST", op: "chats.switchAgent", params: input }, 30_000);
  });

  it("reports a chat that already left the previous agent as stale", async () => {
    const { bridge } = bridgeReturning({ type: "WORKSPACE_RESPONSE", op: "chats.switchAgent", result: { ok: false } });
    await expect(bridgeChatSwitchAgent(bridge, input)).resolves.toBe("stale");
  });

  it("detects an older worker that doesn't know the operation", async () => {
    const { bridge } = bridgeReturning({ type: "WORKSPACE_ERROR", op: "chats.switchAgent", code: "CLOUD_V2_UNSUPPORTED",
      message: "This operation is not available in cloud workspaces yet." });
    await expect(bridgeChatSwitchAgent(bridge, input)).resolves.toBe("unsupported");
  });

  it("surfaces worker refusals", async () => {
    const { bridge } = bridgeReturning({ type: "WORKSPACE_ERROR", op: "chats.switchAgent", code: "VALIDATION_FAILED",
      message: "Send or remove queued messages before switching agent." });
    await expect(bridgeChatSwitchAgent(bridge, input)).rejects.toThrow(/queued messages/);
  });
});
