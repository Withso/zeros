import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentGateway } from "../gateway";
import type { ExecutionBoundary } from "../containment/types";

describe("AgentGateway default execution boundary", () => {
  it("resolves native supervisor assets from the gateway project root", () => {
    const projectRoot = path.join(process.cwd(), "alternate-project-root");
    const gateway = new AgentGateway({
      projectRoot,
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const boundary = (
      gateway as unknown as {
        executionBoundary: {
          options: { host: { projectRoot: string } };
        };
      }
    ).executionBoundary;

    expect(boundary.options.host.projectRoot).toBe(projectRoot);
  });

  it("routes code-only work through native host parity when no boundary is injected", async () => {
    const gateway = new AgentGateway({
      projectRoot: process.cwd(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const boundary = (
      gateway as unknown as { executionBoundary: ExecutionBoundary }
    ).executionBoundary;

    expect(boundary.backend).toBe("none");
    const prepared = await boundary.prepare({
      executionId: "gateway-default-host",
      actor: "agent-code",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      allowedLocalPorts: [],
      trustedLocalPorts: [],
      backendHint: boundary.backend,
    });
    expect(prepared.status).toMatchObject({
      backend: "none",
      state: "not-required",
      parity: { level: "full", restrictions: [] },
      git: { state: "native" },
    });

    await prepared.stopAndProve();
    await gateway.dispose();
  });

  it("reports native supervisor admission failures without calling them Design protection", () => {
    const gateway = new AgentGateway({
      projectRoot: process.cwd(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const failure = (
      gateway as unknown as {
        boundaryAdmissionFailure(
          providerId: string,
          stage: "newSession",
          error: unknown,
        ): { failure: { kind: string; message: string } };
      }
    ).boundaryAdmissionFailure(
      "codex",
      "newSession",
      new Error("host supervisor missing"),
    );

    expect(failure.failure).toMatchObject({
      kind: "protocol-error",
      message: expect.stringMatching(/native agent process supervisor/i),
    });
    expect(failure.failure.message).not.toMatch(/Design protection/i);
  });
});
