import { describe, expect, it, vi } from "vitest";
import { createMessage } from "@zeros/protocol";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import { ZerosEngine } from "../zeros-engine";

const handle = (ZerosEngine.prototype as unknown as {
  handleAgentMessage(this: unknown, message: EngineMessage, client: TransportClient): Promise<void>;
}).handleAgentMessage;

describe("Local goal provenance", () => {
  it.each([undefined, "user"] as const)("passes explicit provenance without inventing it for legacy messages (%s)", async origin => {
    const goal = { objective: "Finish", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    const engine = {
      sessionAgent: new Map([["execution", "codex"]]),
      remoteMayNotActOnSession: () => false,
      cloudGoalClaim: () => undefined,
      agents: { setGoal: vi.fn(async () => goal), clearGoal: vi.fn(async () => {}) },
    };
    const client = { id: "device", kind: "local", send: vi.fn() } as unknown as TransportClient;
    const route = { source: "browser" as const, agentId: "codex", sessionId: "execution", ...(origin ? { origin } : {}) };
    await handle.call(engine, createMessage({ ...route, type: "AGENT_GOAL_SET", update: { objective: " Finish " } }) as EngineMessage, client);
    expect(engine.agents.setGoal).toHaveBeenCalledWith("codex", "execution", { objective: "Finish" }, origin);
    await handle.call(engine, createMessage({ ...route, type: "AGENT_GOAL_CLEAR" }) as EngineMessage, client);
    expect(engine.agents.clearGoal).toHaveBeenCalledWith("codex", "execution", origin);
    expect(client.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "AGENT_GOAL_CHANGED", goal: null }));
  });
  it("does not trust origin asserted over the legacy cloud message route", async () => {
    const engine = {
      cloudWorker: true,
      sessionAgent: new Map([["execution", "codex"]]),
      remoteMayNotActOnSession: () => false,
      cloudGoalClaim: () => undefined,
      authorizeCloudAgentAction: vi.fn(async () => {}),
      agents: { setGoal: vi.fn(async () => null), clearGoal: vi.fn(async () => {}) },
    };
    const client = { id: "device", kind: "cloud", send: vi.fn(), authorized: () => true,
      cloudActor: { sessionId: "authenticated-actor" } } as unknown as TransportClient;
    const route = { source: "browser" as const, agentId: "codex", sessionId: "execution", origin: "user" as const };
    await handle.call(engine, createMessage({ ...route, type: "AGENT_GOAL_SET", update: { objective: "Finish" } }), client);
    await handle.call(engine, createMessage({ ...route, type: "AGENT_GOAL_CLEAR" }), client);
    expect(engine.authorizeCloudAgentAction).toHaveBeenCalledWith("execution", "authenticated-actor");
    expect(engine.agents.setGoal).toHaveBeenCalledWith("codex", "execution", { objective: "Finish" }, undefined);
    expect(engine.agents.clearGoal).toHaveBeenCalledWith("codex", "execution", undefined);
  });
});
