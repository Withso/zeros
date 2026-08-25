// gateway boundary-retirement auto-heal — a failed stop proof latches
// admissions (fail-closed, unchanged) and is retried automatically with
// backoff; a successful retry lifts the hold without an app restart.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type {
  ExecutionBoundary,
  PreparedBoundary,
  TerritoryGeneration,
} from "../containment/types";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

interface GatewayInternals {
  adapters: Map<string, AgentAdapter>;
  executionToAgent: Map<string, string>;
  executionBoundaries: Map<string, PreparedBoundary>;
  failedBoundaryRetirements: Map<string, unknown>;
  boundaryRetirementRecoveryTimers: Map<string, unknown>;
  assertBoundaryRetirementHealthy(): void;
  endSession(
    agentId: string,
    sessionId: string,
    opts: { failClosed: true },
  ): Promise<void>;
  dispose(): Promise<void>;
}

function makeGateway(executionBoundary: ExecutionBoundary): GatewayInternals {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-test",
    executionBoundary,
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  }) as unknown as GatewayInternals;
}

describe("AgentGateway boundary retirement auto-heal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a failed stop proof with backoff and lifts the admission hold on success", async () => {
    const cleared: TerritoryGeneration[] = [];
    const boundaryFactory: ExecutionBoundary = {
      ...testExecutionBoundary(),
      clearRetirementFailure: (generation) => {
        cleared.push(generation);
      },
    };
    const gw = makeGateway(boundaryFactory);
    gw.adapters.set("strict", {
      agentId: "strict",
      disposeSession: async () => {},
    } as unknown as AgentAdapter);
    gw.executionToAgent.set("r1", "strict");
    let stopAttempts = 0;
    gw.executionBoundaries.set("r1", {
      generation: "gen-r1" as TerritoryGeneration,
      revoke: async () => {},
      stopAndProve: async () => {
        stopAttempts += 1;
        if (stopAttempts < 3) throw new Error("descendant still alive");
      },
    } as unknown as PreparedBoundary);

    await expect(
      gw.endSession("strict", "r1", { failClosed: true }),
    ).rejects.toThrow("descendant still alive");
    expect(gw.failedBoundaryRetirements.has("r1")).toBe(true);
    expect(() => gw.assertBoundaryRetirementHealthy()).toThrow(
      /could not be proven stopped/i,
    );

    // First retry (5s) still fails and reschedules.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopAttempts).toBe(2);
    expect(gw.failedBoundaryRetirements.has("r1")).toBe(true);

    // Second retry (15s) succeeds: the hold lifts everywhere at once.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stopAttempts).toBe(3);
    expect(gw.failedBoundaryRetirements.size).toBe(0);
    expect(gw.executionBoundaries.has("r1")).toBe(false);
    expect(cleared).toEqual(["gen-r1"]);
    expect(() => gw.assertBoundaryRetirementHealthy()).not.toThrow();
  });

  it("keeps admissions refused while every retry still fails, and stops retrying after dispose", async () => {
    const gw = makeGateway(testExecutionBoundary());
    gw.adapters.set("strict", {
      agentId: "strict",
      disposeSession: async () => {},
    } as unknown as AgentAdapter);
    gw.executionToAgent.set("r2", "strict");
    let stopAttempts = 0;
    gw.executionBoundaries.set("r2", {
      generation: "gen-r2" as TerritoryGeneration,
      revoke: async () => {},
      stopAndProve: async () => {
        stopAttempts += 1;
        throw new Error("unkillable descendant");
      },
    } as unknown as PreparedBoundary);

    await expect(
      gw.endSession("strict", "r2", { failClosed: true }),
    ).rejects.toThrow("unkillable descendant");
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopAttempts).toBe(4);
    expect(() => gw.assertBoundaryRetirementHealthy()).toThrow(
      /could not be proven stopped/i,
    );

    await gw.dispose().catch(() => undefined);
    expect(gw.boundaryRetirementRecoveryTimers.size).toBe(0);
    const attemptsAtDispose = stopAttempts;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stopAttempts).toBe(attemptsAtDispose);
  });
});
