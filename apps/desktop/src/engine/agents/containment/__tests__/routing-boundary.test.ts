import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutingExecutionBoundary } from "../routing-boundary";
import { createRepoTaskBoundaryFactory } from "../repo-task-boundary";
import { UtilityBoundaryPool } from "../utility-boundary-pool";
import type {
  BoundaryRequest,
  ExecutionBoundary,
  PreparedBoundary,
} from "../types";

const seams = vi.hoisted(() => ({
  cloud: new Set<object>(),
  processes: vi.fn(async () => ({ discovered: 0, recovered: 0, active: 0, preserved: 0 })),
  mutable: vi.fn(async () => ({ discovered: 0, recovered: 0, active: 0, preserved: 0 })),
}));
vi.mock("../legacy-execution-recovery", () => ({ recoverLegacyExecutionProcesses: seams.processes, recoverLegacyMutableState: seams.mutable }));
vi.mock("../cloud-execution-boundary", () => ({ isCloudExecutionBoundary: (value: object) => seams.cloud.has(value) }));
afterEach(() => { vi.clearAllMocks(); seams.cloud.clear(); });

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

function fakeBoundary(backend: "none" | "cloud-worker") {
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
    host.boundary.prepare.mockRejectedValueOnce(new Error("preparation failed"));
    host.boundary.proveFailedPreparationStopped.mockRejectedValueOnce(new Error("cleanup still unproven"));
    const routing = new RoutingExecutionBoundary({ host: host.boundary }) as RoutingExecutionBoundary & {
      proveFailedPreparationStopped(executionId: string): Promise<void>;
    };
    const admission = request("design-agent");

    await expect(routing.prepare(admission, { retainFailedPreparationProof: true })).rejects.toThrow("preparation failed");
    expect(host.boundary.prepare).toHaveBeenCalledWith(admission, { retainFailedPreparationProof: true });
    await expect(routing.proveFailedPreparationStopped(admission.executionId)).rejects.toThrow("cleanup still unproven");
    await expect(routing.proveFailedPreparationStopped(admission.executionId)).resolves.toBeUndefined();
    expect(host.boundary.proveFailedPreparationStopped.mock.calls).toEqual([[admission.executionId], [admission.executionId]]);
  });

  it.each(["utility", "repo-task"] as const)(
    "does not retain or block failed ordinary %s preparations",
    async (operation) => {
      const host = fakeBoundary("none");
        host.boundary.prepare.mockRejectedValue(new Error("preparation failed"));
      const routing = new RoutingExecutionBoundary({
        host: host.boundary,
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
    const routing = new RoutingExecutionBoundary({ host: host.boundary }) as RoutingExecutionBoundary & {
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
        const routing = new RoutingExecutionBoundary({
        host: host.boundary,
      });

      expect(await routing.prepare(request(actor, withTerritory))).toBe(
        host.prepared,
      );
      expect(host.boundary.prepare).toHaveBeenCalledOnce();
    },
  );

  it("routes a legacy Local Design actor through Host without kernel enforcement", async () => {
    const host = fakeBoundary("none"), routing = new RoutingExecutionBoundary({ host: host.boundary });
    expect(await routing.prepare(request("design-agent", true))).toBe(host.prepared);
    expect(host.boundary.prepare).toHaveBeenCalledOnce();
  });
  it("preserves Local Design Host preparation failures", async () => {
    const host = fakeBoundary("none"), routing = new RoutingExecutionBoundary({ host: host.boundary });
    host.boundary.prepare.mockRejectedValueOnce(new Error("Host unavailable"));
    await expect(routing.prepare(request("design-agent", true))).rejects.toThrow("Host unavailable");
  });
  it("selects only the original cloud placement instead of a backend hint", async () => {
    const host = fakeBoundary("none"), cloud = fakeBoundary("cloud-worker");
    expect(() => new RoutingExecutionBoundary({ host: host.boundary, cloud: cloud.boundary })).toThrow();
    seams.cloud.add(cloud.boundary);
    const routing = new RoutingExecutionBoundary({ host: host.boundary, cloud: cloud.boundary });
    expect(await routing.prepare(request())).toBe(cloud.prepared);
    expect(host.boundary.prepare).not.toHaveBeenCalled();
  });
  it("recovers Host processes and neutral legacy holds before mutable state", async () => {
    const host = fakeBoundary("none"), routing = new RoutingExecutionBoundary({ host: host.boundary });
    await routing.recoverStaleProcesses(); await routing.recoverStaleMutableState();
    expect(host.boundary.recoverStaleProcesses).toHaveBeenCalledOnce();
    expect(seams.processes).toHaveBeenCalledOnce(); expect(seams.mutable).toHaveBeenCalledOnce();
  });
  it("attempts both recoveries when Host recovery fails", async () => {
    const host = fakeBoundary("none"), routing = new RoutingExecutionBoundary({ host: host.boundary });
    host.boundary.recoverStaleProcesses.mockRejectedValueOnce(new Error("native recovery failed"));
    await expect(routing.recoverStaleProcesses()).rejects.toThrow("native recovery failed");
    expect(seams.processes).toHaveBeenCalledOnce();
  });
  it("preserves ambiguous legacy holds instead of starting the old helper", async () => {
    const host = fakeBoundary("none"), routing = new RoutingExecutionBoundary({ host: host.boundary });
    seams.processes.mockRejectedValueOnce(Object.assign(new Error("legacy hold"), { code: "legacy_execution_recovery_required" }));
    await expect(routing.recoverStaleProcesses()).rejects.toMatchObject({ code: "legacy_execution_recovery_required" });
    expect(host.boundary.recoverStaleProcesses).toHaveBeenCalledOnce();
  });
});
