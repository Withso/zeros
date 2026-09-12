import { describe, expect, it } from "vitest";

import type { AgentFilesystemTerritory } from "../../types";
import {
  boundaryParityRestrictions,
  hasKernelExecutionBoundary,
  newTerritoryGeneration,
  readyBoundaryStatus,
  unavailableBoundaryStatus,
} from "../status";

const territory: AgentFilesystemTerritory = {
  agentRole: "code",
  workspaceRoot: "/private/work/repo",
  designDirectory: "/private/work/repo/Zeros Design",
  protectedDesignDirectories: ["/private/work/repo/Zeros Design"],
  designRecognitionPaths: [],
  writeCapabilities: {
    workspace: "write",
    deniedPaths: ["/private/work/repo/Zeros Design", "/private/work/repo/.git"],
  },
};

describe("execution boundary status contract", () => {
  it("mints an opaque generation for every admission and redacts paths", () => {
    const firstGeneration = newTerritoryGeneration();
    const secondGeneration = newTerritoryGeneration();
    const status = readyBoundaryStatus({
      territory,
      generation: firstGeneration,
      checkedAt: 42,
    });

    expect(secondGeneration).not.toBe(firstGeneration);
    expect(status).toMatchObject({
      version: 1,
      actor: "agent-code",
      state: "ready",
      backend: "zeros-srt",
      designProtection: {
        required: true,
        enforced: true,
        protectedDirectoryCount: 1,
        territoryGeneration: firstGeneration,
      },
      parity: {
        level: "full",
        restrictions: [],
      },
      checkedAt: 42,
    });
    expect(JSON.stringify(status)).not.toContain("/private/work");
  });

  it("keeps ordinary code-only workspaces inside the uniform runtime", () => {
    expect(readyBoundaryStatus({})).toMatchObject({
      state: "ready",
      backend: "zeros-srt",
      designProtection: { required: false, enforced: false },
      parity: { level: "full", restrictions: [] },
    });
  });

  it("distinguishes host process supervision from a kernel execution boundary", () => {
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "none", state: "not-required" },
      }),
    ).toBe(false);
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "none", state: "ready" },
      }),
    ).toBe(false);
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "zeros-srt", state: "ready" },
      }),
    ).toBe(true);
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "cloud-worker", state: "ready" },
      }),
    ).toBe(true);
    expect(hasKernelExecutionBoundary(undefined)).toBe(false);
  });

  it("reports an expected container CLI as restricted without a private worker", () => {
    expect(
      boundaryParityRestrictions({ containerWorkflowExpected: true }),
    ).toEqual(["container-workflows-unavailable"]);
    expect(
      boundaryParityRestrictions(
        { containerWorkflowExpected: true },
        { containerWorkflowAvailable: true },
      ),
    ).toEqual([]);
    expect(boundaryParityRestrictions({})).toEqual([]);
  });

  it("carries only actionable remediation for an unavailable boundary", () => {
    const status = unavailableBoundaryStatus({
      remediation: "Enable the qualified sandbox and retry.",
      checkedAt: 7,
    });
    expect(status).toMatchObject({
      state: "unavailable",
      designProtection: { required: true, enforced: false },
      remediation: "Enable the qualified sandbox and retry.",
      checkedAt: 7,
    });
  });
});
