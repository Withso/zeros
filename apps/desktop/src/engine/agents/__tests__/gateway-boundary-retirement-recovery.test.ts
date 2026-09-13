// Gateway boundary-retirement auto-heal — a failed stop proof remains owned by
// that exact execution and is retried with backoff without poisoning unrelated
// agents, utilities, Run/Setup, auth, or app-core state.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type {
  ExecutionBoundary,
  PreparedBoundary,
  TerritoryGeneration,
} from "../containment/types";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      // CI's shared temp root contains unreadable system-owned entries. Keep
      // that failure deterministic so these tests require their own workspace.
      const target = path.resolve(String(args[0]));
      if (target === "/tmp" || target === actual.realpathSync(tmpdir())) {
        throw Object.assign(
          new Error("Cannot scan the shared temp directory"),
          {
            code: "EACCES",
          },
        );
      }
      return actual.readdirSync(...args);
    },
  };
});

let fixtureRoot: string;

interface GatewayInternals {
  adapters: Map<string, AgentAdapter>;
  executionToAgent: Map<string, string>;
  executionBoundaries: Map<string, PreparedBoundary>;
  failedBoundaryRetirements: Map<string, unknown>;
  boundaryRetirementRecoveryTimers: Map<string, unknown>;
  newSession(
    agentId: string,
    opts: { cwd: string },
  ): Promise<{ executionId: string }>;
  endSession(
    agentId: string,
    sessionId: string,
    opts: { failClosed: true },
  ): Promise<void>;
  assertRegisteredDesignAuthorityRetirementsProven(): void;
  assertWorkspaceDesignAuthorityRetirementsProven(workspaceRoot: string): void;
  dispose(): Promise<void>;
}

function makeGateway(executionBoundary: ExecutionBoundary): GatewayInternals {
  return new AgentGateway({
    projectRoot: fixtureRoot,
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
    fixtureRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "zeros-gateway-retirement-recovery-")),
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("retries a failed stop proof without holding unrelated admissions", async () => {
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
      newSession: async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      }),
      disposeSession: async () => {},
    } as unknown as AgentAdapter);
    gw.executionToAgent.set("r1", "strict");
    let stopAttempts = 0;
    gw.executionBoundaries.set("r1", {
      generation: "gen-r1" as TerritoryGeneration,
      registeredDesignAuthorityIdentity: "registered-v1",
      territoryContributions: [
        {
          workspaceRoot: fixtureRoot,
          grants: [],
          full: true,
          identity: "workspace-v1",
        },
      ],
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
    expect(() => gw.assertRegisteredDesignAuthorityRetirementsProven()).toThrow(
      /not yet proven stopped/i,
    );
    expect(() =>
      gw.assertWorkspaceDesignAuthorityRetirementsProven(fixtureRoot),
    ).toThrow(/not yet proven stopped/i);
    expect(() =>
      gw.assertWorkspaceDesignAuthorityRetirementsProven("/unrelated"),
    ).not.toThrow();
    await expect(
      gw.newSession("strict", { cwd: fixtureRoot }),
    ).resolves.toMatchObject({ executionId: expect.any(String) });

    // First retry (5s) still fails and reschedules.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopAttempts).toBe(2);
    expect(gw.failedBoundaryRetirements.has("r1")).toBe(true);

    // Second retry (15s) proves and clears only r1.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stopAttempts).toBe(3);
    expect(gw.failedBoundaryRetirements.size).toBe(0);
    expect(gw.executionBoundaries.has("r1")).toBe(false);
    expect(cleared).toEqual(["gen-r1"]);
    expect(() =>
      gw.assertRegisteredDesignAuthorityRetirementsProven(),
    ).not.toThrow();
  });

  it("keeps retrying the exact failed proof and stops retrying after dispose", async () => {
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
    await gw.dispose().catch(() => undefined);
    expect(gw.boundaryRetirementRecoveryTimers.size).toBe(0);
    const attemptsAtDispose = stopAttempts;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stopAttempts).toBe(attemptsAtDispose);
  });
});
