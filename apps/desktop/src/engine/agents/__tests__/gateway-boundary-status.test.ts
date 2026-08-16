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
});
