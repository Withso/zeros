// gateway.adapterForSession — recovery classification. Verifies that a
// prompt against a sessionId the gateway no longer knows about (the
// classic "engine restarted between turns, renderer still holds the old
// sessionId" case) fails with a RECOVERABLE `session-expired` failure
// rather than a bare Error the renderer treats as a hard, non-recoverable
// "claude: Agent error — adapter not live" toast. See the comment in
// gateway.ts adapterForSession + isRecoverable() in zeros/bridge/failure.ts.

import { describe, expect, it } from "vitest";

import { AgentGateway } from "../gateway";
import { AgentFailureError, type AgentAdapter } from "../types";

function makeGateway() {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-test",
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
}

describe("AgentGateway session/adapter recovery classification", () => {
  it("throws a recoverable session-expired failure when no route AND no adapter exist (fresh gateway after engine restart)", async () => {
    const gw = makeGateway();
    let caught: unknown;
    try {
      await gw.prompt("claude", "stale-session-id", [
        { type: "text", text: "hi" },
      ] as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentFailureError);
    expect((caught as AgentFailureError).failure.kind).toBe("session-expired");
  });

  it("throws session-expired (NOT protocol-error) when the route survived but the adapter map was cleared", async () => {
    const gw = makeGateway() as unknown as {
      sessionToAgent: Map<string, string>;
      adapters: Map<string, AgentAdapter>;
      prompt(a: string, s: string, p: unknown[]): Promise<unknown>;
    };
    // A route exists (renderer's sessionId still maps to "claude") but the
    // adapter is gone — exactly what gateway.dispose() leaves behind on an
    // engine respawn.
    gw.sessionToAgent.set("s1", "claude");

    let caught: unknown;
    try {
      await gw.prompt("claude", "s1", []);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentFailureError);
    const failure = (caught as AgentFailureError).failure;
    expect(failure.kind).toBe("session-expired");
    expect(failure.message).toContain("adapter not live");
  });

  it("routes to the live adapter when both the route and adapter are present", async () => {
    const gw = makeGateway() as unknown as {
      sessionToAgent: Map<string, string>;
      adapters: Map<string, AgentAdapter>;
      prompt(a: string, s: string, p: unknown[]): Promise<unknown>;
    };
    const seen: string[] = [];
    gw.adapters.set("claude", {
      agentId: "claude",
      prompt: async ({ sessionId }: { sessionId: string }) => {
        seen.push(sessionId);
        return { stopReason: "end_turn", response: {} };
      },
      respondToPermission: () => {},
    } as unknown as AgentAdapter);
    gw.sessionToAgent.set("s2", "claude");

    await gw.prompt("claude", "s2", []);
    expect(seen).toEqual(["s2"]);
  });
});
