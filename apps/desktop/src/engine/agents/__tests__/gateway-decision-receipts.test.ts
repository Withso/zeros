import { describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import { ClaudeSdkAdapter } from "../adapters/claude-sdk/adapter";

describe("native decision delivery receipts", () => {
  it("returns whether any adapter actually settled the decision", () => {
    const gateway = { adapters: new Map([
      ["first", { respondToPermission: () => false, respondToQuestion: () => false }],
      ["second", { respondToPermission: () => true, respondToQuestion: () => true }],
    ]) };
    const permission = { outcome: { outcome: "cancelled" as const } };
    const question = { outcome: { outcome: "dismissed" as const } };
    expect(AgentGateway.prototype.answerPermission.call(gateway as never, "request", permission)).toBe(true);
    expect(AgentGateway.prototype.answerQuestion.call(gateway as never, "request", question)).toBe(true);
    gateway.adapters.delete("second");
    expect(AgentGateway.prototype.answerPermission.call(gateway as never, "expired", permission)).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { expect(AgentGateway.prototype.answerQuestion.call(gateway as never, "expired", question)).toBe(false); }
    finally { warn.mockRestore(); }
  });
  it("returns a single-use native permission result for Claude", () => {
    const resolver = vi.fn(); const adapter = { sessions: new Map([["session", { pendingPermissions: new Map([["permission", resolver]]) }]]) };
    const request = { permissionId: "permission", response: { outcome: { outcome: "cancelled" as const } } };
    expect(ClaudeSdkAdapter.prototype.respondToPermission.call(adapter as never, request)).toBe(true);
    expect(ClaudeSdkAdapter.prototype.respondToPermission.call(adapter as never, request)).toBe(false);
    expect(resolver).toHaveBeenCalledOnce();
  });
});
