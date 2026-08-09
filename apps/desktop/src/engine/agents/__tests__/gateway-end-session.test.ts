// gateway.endSession — per-session teardown. Verifies that closing a chat
// clears the gateway's routing maps and delegates to the owning adapter's
// disposeSession (the fix for the "live hook token + session dir + server
// child leak until app quit" finding).

import { describe, expect, it } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";

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

describe("AgentGateway.endSession", () => {
  it("clears routing maps and calls the adapter's disposeSession", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      sessionToAgent: Map<string, string>;
      sessionToWorkspace: Map<string, string>;
      endSession(agentId: string, sessionId: string): Promise<void>;
    };

    const disposed: string[] = [];
    const fake = {
      agentId: "fake",
      disposeSession: async (id: string) => {
        disposed.push(id);
      },
    } as unknown as AgentAdapter;

    gw.adapters.set("fake", fake);
    gw.sessionToAgent.set("s1", "fake");
    gw.sessionToWorkspace.set("s1", "w1");

    await gw.endSession("fake", "s1");

    expect(disposed).toEqual(["s1"]);
    expect(gw.sessionToAgent.has("s1")).toBe(false);
    expect(gw.sessionToWorkspace.has("s1")).toBe(false);
  });

  it("resolves the agent from the session map when the caller's agentId is stale", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      sessionToAgent: Map<string, string>;
      endSession(agentId: string, sessionId: string): Promise<void>;
    };
    const disposed: string[] = [];
    gw.adapters.set("real", {
      agentId: "real",
      disposeSession: async (id: string) => disposed.push(id),
    } as unknown as AgentAdapter);
    gw.sessionToAgent.set("s2", "real");

    // Caller passes the wrong agentId; endSession should still route to
    // "real" via sessionToAgent.
    await gw.endSession("wrong", "s2");
    expect(disposed).toEqual(["s2"]);
  });

  it("is a no-op (no throw) when the adapter has no disposeSession", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      sessionToAgent: Map<string, string>;
      endSession(agentId: string, sessionId: string): Promise<void>;
    };
    gw.adapters.set("bare", { agentId: "bare" } as unknown as AgentAdapter);
    gw.sessionToAgent.set("s3", "bare");
    await expect(gw.endSession("bare", "s3")).resolves.toBeUndefined();
    expect(gw.sessionToAgent.has("s3")).toBe(false);
  });

  it("propagates adapter teardown failure when the caller must fail closed", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      sessionToAgent: Map<string, string>;
      endSession(
        agentId: string,
        sessionId: string,
        opts: { failClosed: true },
      ): Promise<void>;
    };
    gw.adapters.set("strict", {
      agentId: "strict",
      disposeSession: async () => {
        throw new Error("process group still alive");
      },
    } as unknown as AgentAdapter);
    gw.sessionToAgent.set("s4", "strict");

    await expect(
      gw.endSession("strict", "s4", { failClosed: true }),
    ).rejects.toThrow("process group still alive");
    // Routing still clears even when the resource teardown could not be
    // confirmed. Archive retains its separate lifecycle tombstone and aborts.
    expect(gw.sessionToAgent.has("s4")).toBe(false);
  });
});
