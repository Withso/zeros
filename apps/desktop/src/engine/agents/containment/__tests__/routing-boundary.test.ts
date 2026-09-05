import { describe, expect, it, vi } from "vitest";

import { RoutingExecutionBoundary } from "../routing-boundary";
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
  } satisfies ExecutionBoundary;
  return { boundary, prepared };
}

describe("execution-boundary routing", () => {
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
