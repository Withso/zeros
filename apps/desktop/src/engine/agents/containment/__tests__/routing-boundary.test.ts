import { describe, expect, it, vi } from "vitest";

import { RoutingExecutionBoundary } from "../routing-boundary";
import { createRepoTaskBoundaryFactory } from "../repo-task-boundary";
import { UtilityBoundaryPool } from "../utility-boundary-pool";
import type {
  BoundaryRequest,
  ExecutionBoundary,
  PreparedBoundary,
} from "../types";

function request(
  actor: BoundaryRequest["actor"] = "agent-code",
  withTerritory = false,
): BoundaryRequest {
  return {
    executionId: `${actor}-execution`,
    actor,
    cwd: "/work/repo",
    workspaceRoot: "/work/repo",
    ...(withTerritory
      ? {
          territory: {
            agentRole: "code" as const,
            workspaceRoot: "/work/repo",
            designDirectory: "/work/repo/Zeros Design",
            protectedDesignDirectories: ["/work/repo/Zeros Design"],
            designRecognitionPaths: [],
            writeCapabilities: {
              workspace: "write" as const,
              deniedPaths: ["/work/repo/Zeros Design"],
            },
          },
        }
      : {}),
  };
}

function fakeBoundary(backend: "none" | "zeros-srt") {
  const prepared = { generation: `${backend}-generation` } as PreparedBoundary;
  const boundary = {
    backend,
    probe: vi.fn(async () => ({
      backend,
      available: true,
      secureNestedIsolation: backend !== "none",
      reasons: [],
    })),
    prepare: vi.fn(async () => prepared),
    recoverStaleProcesses: vi.fn(async () => ({
      discovered: 0,
      recovered: 0,
      active: 0,
      preserved: 0,
    })),
    recoverStaleMutableState: vi.fn(async () => ({
      discovered: 0,
      recovered: 0,
      active: 0,
      preserved: 0,
    })),
    clearRetirementFailure: vi.fn(),
    proveFailedPreparationStopped: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(),
  } satisfies ExecutionBoundary;
  return { boundary, prepared };
}

describe("execution-boundary routing", () => {
  it("proves a rejected preparation only through its selected backend and retains failed proof for retry", async () => {
    const host = fakeBoundary("none");
    const sandbox = fakeBoundary("zeros-srt");
    sandbox.boundary.prepare.mockRejectedValueOnce(new Error("preparation failed"));
    sandbox.boundary.proveFailedPreparationStopped.mockRejectedValueOnce(new Error("cleanup still unproven"));
    const routing = new RoutingExecutionBoundary({ host: host.boundary, sandbox: sandbox.boundary }) as RoutingExecutionBoundary & {
      proveFailedPreparationStopped(executionId: string): Promise<void>;
    };
    const admission = request("design-agent");

    await expect(routing.prepare(admission, { retainFailedPreparationProof: true })).rejects.toThrow("preparation failed");
    expect(sandbox.boundary.prepare).toHaveBeenCalledWith(admission, { retainFailedPreparationProof: true });
    await expect(routing.proveFailedPreparationStopped(admission.executionId)).rejects.toThrow("cleanup still unproven");
    await expect(routing.proveFailedPreparationStopped(admission.executionId)).resolves.toBeUndefined();
    expect(sandbox.boundary.proveFailedPreparationStopped.mock.calls).toEqual([[admission.executionId], [admission.executionId]]);
    expect(host.boundary.proveFailedPreparationStopped).not.toHaveBeenCalled();
  });

  it.each(["utility", "repo-task"] as const)(
    "does not retain or block failed ordinary %s preparations",
    async (operation) => {
      const host = fakeBoundary("none");
      const sandbox = fakeBoundary("zeros-srt");
      host.boundary.prepare.mockRejectedValue(new Error("preparation failed"));
      const routing = new RoutingExecutionBoundary({
        host: host.boundary,
        sandbox: sandbox.boundary,
      });
      const internals = routing as unknown as {
        failedPreparationOwners: Map<string, ExecutionBoundary>;
      };
      const admission = request();
      const pool = new UtilityBoundaryPool({
        prepare: (candidate) => routing.prepare(candidate),
        retire: async () => {},
      });
      const factory = createRepoTaskBoundaryFactory(routing);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pending = operation === "utility"
          ? pool.acquire(admission)
          : factory({ ...admission, repoRoot: admission.workspaceRoot });
        await expect(pending).rejects.toThrow("preparation failed");
        expect(internals.failedPreparationOwners.size).toBe(0);
        await expect(routing.proveFailedPreparationStopped(admission.executionId)).rejects.toThrow();
      }
      expect(host.boundary.prepare).toHaveBeenCalledTimes(3);
      expect(host.boundary.proveFailedPreparationStopped).not.toHaveBeenCalled();
    },
  );

  it("refuses unknown and successfully admitted executions through the failed-preparation seam", async () => {
    const host = fakeBoundary("none");
    const sandbox = fakeBoundary("zeros-srt");
    const routing = new RoutingExecutionBoundary({ host: host.boundary, sandbox: sandbox.boundary }) as RoutingExecutionBoundary & {
      proveFailedPreparationStopped(executionId: string): Promise<void>;
    };
    await expect(routing.proveFailedPreparationStopped("unknown")).rejects.toThrow();
    const admission = request();
    await routing.prepare(admission);
    await expect(routing.proveFailedPreparationStopped(admission.executionId)).rejects.toThrow();
    expect(host.boundary.proveFailedPreparationStopped).not.toHaveBeenCalled();
  });

  it.each([
    ["agent-code", false],
    ["agent-code", true],
    ["repo-code-task", false],
    ["repo-code-task", true],
  ] as const)(
    "keeps local %s work native regardless of Design territory (%s)",
    async (actor, withTerritory) => {
      const host = fakeBoundary("none");
      const sandbox = fakeBoundary("zeros-srt");
      const routing = new RoutingExecutionBoundary({
        host: host.boundary,
        sandbox: sandbox.boundary,
      });

      expect(await routing.prepare(request(actor, withTerritory))).toBe(
        host.prepared,
      );
      expect(host.boundary.prepare).toHaveBeenCalledOnce();
      expect(sandbox.boundary.prepare).not.toHaveBeenCalled();
    },
  );

  it("always places a local Design agent in ZSR", async () => {
    const host = fakeBoundary("none");
    const sandbox = fakeBoundary("zeros-srt");
    const routing = new RoutingExecutionBoundary({
      host: host.boundary,
      sandbox: sandbox.boundary,
    });

    expect(await routing.prepare(request("design-agent", true))).toBe(
      sandbox.prepared,
    );
    expect(host.boundary.prepare).not.toHaveBeenCalled();
  });

  it("does not fall back to native execution when Design-agent ZSR preparation fails", async () => {
    const host = fakeBoundary("none");
    const sandbox = fakeBoundary("zeros-srt");
    vi.mocked(sandbox.boundary.prepare).mockRejectedValueOnce(
      new Error("ZSR unavailable"),
    );
    const routing = new RoutingExecutionBoundary({
      host: host.boundary,
      sandbox: sandbox.boundary,
    });

    await expect(
      routing.prepare(request("design-agent", true)),
    ).rejects.toThrow("ZSR unavailable");
    expect(host.boundary.prepare).not.toHaveBeenCalled();
  });

  it("pins cloud deployments to the qualified cloud boundary", async () => {
    const host = fakeBoundary("none");
    const sandbox = fakeBoundary("zeros-srt");
    const routing = new RoutingExecutionBoundary({
      host: host.boundary,
      sandbox: sandbox.boundary,
      forceSandbox: true,
    });

    expect(await routing.prepare(request())).toBe(sandbox.prepared);
    expect(host.boundary.prepare).not.toHaveBeenCalled();
  });

  it("recovers both local process-domain implementations before publishing authority", async () => {
    const host = fakeBoundary("none");
    const sandbox = fakeBoundary("zeros-srt");
    const routing = new RoutingExecutionBoundary({
      host: host.boundary,
      sandbox: sandbox.boundary,
    });

    await routing.recoverStaleProcesses();
    await routing.recoverStaleMutableState();
    expect(host.boundary.recoverStaleProcesses).toHaveBeenCalledOnce();
    expect(sandbox.boundary.recoverStaleProcesses).toHaveBeenCalledOnce();
    expect(sandbox.boundary.recoverStaleMutableState).toHaveBeenCalledOnce();
  });

  it("attempts both process recoveries when one backend fails", async () => {
    const host = fakeBoundary("none");
    const sandbox = fakeBoundary("zeros-srt");
    vi.mocked(host.boundary.recoverStaleProcesses!).mockRejectedValueOnce(
      new Error("native recovery failed"),
    );
    const routing = new RoutingExecutionBoundary({
      host: host.boundary,
      sandbox: sandbox.boundary,
    });

    await expect(routing.recoverStaleProcesses()).rejects.toThrow(
      /native recovery failed/i,
    );
    expect(host.boundary.recoverStaleProcesses).toHaveBeenCalledOnce();
    expect(sandbox.boundary.recoverStaleProcesses).toHaveBeenCalledOnce();
  });
});
