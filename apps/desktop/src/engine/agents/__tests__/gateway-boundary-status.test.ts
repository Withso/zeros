import { describe, expect, it, vi } from "vitest";

import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";

import { AgentGateway } from "../gateway";
import type { PreparedBoundary } from "../containment/types";
import type { AgentAdapter, PromptResponse } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

function initialStatus(): ExecutionBoundaryStatus {
  return {
    version: 1,
    actor: "agent-code",
    state: "ready",
    backend: "zeros-srt",
    designProtection: {
      required: true,
      enforced: true,
      protectedDirectoryCount: 1,
      territoryGeneration: "opaque-generation",
    },
    parity: { level: "full", restrictions: [] },
    services: {
      state: "ready",
      activeCount: 1,
      kinds: ["database"],
    },
    git: { state: "ready" },
    checkedAt: 1,
  };
}

describe("AgentGateway boundary status publication", () => {
  it("publishes redacted private-Git transitions and retains mapped services", async () => {
    const events: ExecutionBoundaryStatus[] = [];
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-boundary-status",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
        onBoundaryStatusChanged: (_agentId, executionId, status) => {
          expect(executionId).toBe("execution-1");
          events.push(status);
        },
      },
    });
    const prepared = await testExecutionBoundary().prepare({
      executionId: "execution-1",
      actor: "agent-code",
      providerId: "fake",
      cwd: "/tmp/zeros-boundary-status",
      workspaceRoot: "/tmp/zeros-boundary-status",
      backendHint: "zeros-srt",
    });
    const synchronizeGit = vi.fn().mockResolvedValue({
      state: "promoted" as const,
      updatedRefs: 1,
      indexUpdated: true,
    });
    const boundary = {
      ...prepared,
      status: initialStatus(),
      synchronizeGit,
    } as PreparedBoundary;
    const adapter = {
      agentId: "fake",
      dispose: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue({
        response: { stopReason: "end_turn" } as PromptResponse,
      }),
    } as unknown as AgentAdapter;
    const internal = gateway as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionToBoundaryStatus: Map<string, ExecutionBoundaryStatus>;
      executionBoundaries: Map<string, PreparedBoundary>;
    };
    internal.adapters.set("fake", adapter);
    internal.executionToAgent.set("execution-1", "fake");
    internal.executionToBoundaryStatus.set("execution-1", boundary.status);
    internal.executionBoundaries.set("execution-1", boundary);

    await gateway.prompt("fake", "execution-1", []);

    expect(synchronizeGit).toHaveBeenCalledTimes(1);
    expect(events.map((status) => status.git?.state)).toEqual([
      "synchronizing",
      "promoted",
    ]);
    expect(events.at(-1)).toMatchObject({
      state: "ready",
      services: { activeCount: 1, kinds: ["database"] },
      git: { state: "promoted", updatedRefs: 1, indexUpdated: true },
    });
    expect(JSON.stringify(events)).not.toMatch(
      /\/tmp|refs\/heads|socket|token/i,
    );

    await gateway.dispose();
  });

  it("leaves a native Git session's row alone across a turn", async () => {
    const events: ExecutionBoundaryStatus[] = [];
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-boundary-native",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
        onBoundaryStatusChanged: (_agentId, _executionId, status) =>
          events.push(status),
      },
    });
    const prepared = await testExecutionBoundary().prepare({
      executionId: "execution-native",
      actor: "agent-code",
      providerId: "fake",
      cwd: "/tmp/zeros-boundary-native",
      workspaceRoot: "/tmp/zeros-boundary-native",
      backendHint: "zeros-srt",
    });
    // A local host-parity boundary has no private projection, so its
    // synchronizeGit() reports "not-applicable" every turn. Publishing that would
    // relabel a real Git repository as "Not a Git workspace" after the first
    // message — the bug this pins.
    const synchronizeGit = vi.fn().mockResolvedValue({
      state: "not-applicable" as const,
      updatedRefs: 0,
      indexUpdated: false,
    });
    const boundary = {
      ...prepared,
      status: { ...initialStatus(), git: { state: "native" as const } },
      synchronizeGit,
    } as PreparedBoundary;
    const adapter = {
      agentId: "fake",
      dispose: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue({
        response: { stopReason: "end_turn" } as PromptResponse,
      }),
    } as unknown as AgentAdapter;
    const internal = gateway as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionToBoundaryStatus: Map<string, ExecutionBoundaryStatus>;
      executionBoundaries: Map<string, PreparedBoundary>;
    };
    internal.adapters.set("fake", adapter);
    internal.executionToAgent.set("execution-native", "fake");
    internal.executionToBoundaryStatus.set("execution-native", boundary.status);
    internal.executionBoundaries.set("execution-native", boundary);

    await gateway.prompt("fake", "execution-native", []);

    expect(events.map((status) => status.git?.state)).toEqual([]);
    expect(
      internal.executionToBoundaryStatus.get("execution-native")?.git?.state,
    ).toBe("native");

    await gateway.dispose();
  });

  it("publishes a draining status before a territory restart", () => {
    const events: ExecutionBoundaryStatus[] = [];
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-boundary-restart",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
        onBoundaryStatusChanged: (_agentId, _executionId, status) =>
          events.push(status),
      },
    });
    const internal = gateway as unknown as {
      executionToAgent: Map<string, string>;
      executionToBoundaryStatus: Map<string, ExecutionBoundaryStatus>;
    };
    internal.executionToAgent.set("execution-2", "fake");
    internal.executionToBoundaryStatus.set("execution-2", initialStatus());

    expect(
      gateway.markBoundaryDraining("execution-2", "territory-restart"),
    ).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: "draining",
      lifecycle: { lastTransition: "territory-restart" },
    });
  });

  it("publishes a terminal revoked status when a drained execution is retired", async () => {
    // Without a terminal publish, the draining/territory-restart overlay is
    // the LAST status the renderer ever receives for this execution — the
    // composer's boundary pill spun forever on a restart that had finished.
    const events: ExecutionBoundaryStatus[] = [];
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-boundary-terminal",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
        onBoundaryStatusChanged: (_agentId, _executionId, status) =>
          events.push(status),
      },
    });
    const internal = gateway as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionToBoundaryStatus: Map<string, ExecutionBoundaryStatus>;
    };
    internal.adapters.set("fake", {
      agentId: "fake",
      dispose: vi.fn().mockResolvedValue(undefined),
      disposeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentAdapter);
    internal.executionToAgent.set("execution-3", "fake");
    internal.executionToBoundaryStatus.set("execution-3", initialStatus());

    gateway.markBoundaryDraining("execution-3", "territory-restart");
    await gateway.endSession("fake", "execution-3");

    expect(events.map((status) => status.state)).toEqual([
      "draining",
      "revoked",
    ]);
    expect(events.at(-1)?.lifecycle).toBeUndefined();

    await gateway.dispose();
  });

  it("clears the draining overlay for a session that survived a failed retire", () => {
    // A territory transition that could not stop a streaming turn leaves the
    // session live and routable; its pill must return to ready rather than
    // advertise a restart nothing will ever complete.
    const events: ExecutionBoundaryStatus[] = [];
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-boundary-undrain",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
        onBoundaryStatusChanged: (_agentId, _executionId, status) =>
          events.push(status),
      },
    });
    const internal = gateway as unknown as {
      executionToAgent: Map<string, string>;
      executionToBoundaryStatus: Map<string, ExecutionBoundaryStatus>;
    };
    internal.executionToAgent.set("execution-4", "fake");
    internal.executionToBoundaryStatus.set("execution-4", initialStatus());

    // Nothing to clear on a healthy session — and no republish noise either.
    expect(gateway.markBoundaryDrainingCleared("execution-4")).toBe(false);
    expect(events).toHaveLength(0);

    gateway.markBoundaryDraining("execution-4", "territory-restart");
    expect(gateway.markBoundaryDrainingCleared("execution-4")).toBe(true);

    expect(events.map((status) => status.state)).toEqual([
      "draining",
      "ready",
    ]);
    expect(events.at(-1)?.lifecycle).toBeUndefined();
  });
});
