import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentGateway } from "../gateway";
import { AgentFailureError } from "../types";
import { AdmissionCancelledError } from "../containment/admission-gate";
import type { BoundaryRequest } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function gatewayRecordingRequests(): Promise<{
  gateway: AgentGateway;
  requests: BoundaryRequest[];
  root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-admission-"));
  temporaryDirectories.push(root);
  const requests: BoundaryRequest[] = [];
  const gateway = new AgentGateway({
    projectRoot: root,
    executionBoundary: testExecutionBoundary({
      onPrepare: (request) => requests.push(request),
    }),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
  return { gateway, requests, root };
}

describe("AgentGateway admission priority", () => {
  it("marks provider probes as background so a registry refresh cannot delay a chat", async () => {
    // A real engine log showed AGENT_LIST_AGENTS probes and chat titles making
    // up roughly a third of all admissions, queued in front of the sessions the
    // user was actually starting.
    const { gateway, requests } = await gatewayRecordingRequests();
    const internal = gateway as unknown as {
      runProviderProbeCommand(
        providerId: string,
        binary: string,
        args: string[],
        options: { timeoutMs: number },
      ): Promise<{ exitCode: number | null; stdout: string }>;
    };

    await internal.runProviderProbeCommand(
      "codex",
      process.execPath,
      ["-e", "process.stdout.write('probe 1.2.3\\n')"],
      { timeoutMs: 5_000 },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.admissionPriority).toBe("background");

    await gateway.dispose();
  });

  it("marks the diagnostic preflight as background", async () => {
    const { gateway, requests, root } = await gatewayRecordingRequests();

    await gateway.preflightSession("codex", { cwd: root });

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.admissionPriority).toBe("background");
    }

    await gateway.dispose();
  });

  it("leaves a session admission interactive", async () => {
    // The default must stay interactive: a new priority must never silently
    // deprioritize the path a person is waiting on.
    const { gateway, requests, root } = await gatewayRecordingRequests();
    const internal = gateway as unknown as {
      boundaryRequest(
        executionId: string,
        cwd: string,
        workspaceRoot: string | undefined,
        territory: undefined,
        env: undefined,
        providerId: string | undefined,
        mcpServers: readonly never[],
      ): Promise<BoundaryRequest>;
    };

    const request = await internal.boundaryRequest(
      "session-1",
      root,
      root,
      undefined,
      undefined,
      "codex",
      [],
    );

    // Absent means interactive; the boundary resolves the default so the wire
    // shape stays unchanged for every existing caller.
    expect(request.admissionPriority).toBeUndefined();
    expect(requests).toHaveLength(0);

    await gateway.dispose();
  });

  it("threads the conversation's admission signal down to the boundary", async () => {
    // Cancel-on-close only works if the signal the engine mints for the
    // conversation bind actually reaches the gate. The request itself must NOT
    // carry it (the utility pool hashes requests for reuse keys), so it rides
    // the out-of-band AdmissionControl parameter.
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-admission-"));
    temporaryDirectories.push(root);
    let observedSignal: AbortSignal | undefined;
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        onPrepare: (_request, control) => {
          observedSignal = control?.signal;
        },
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const internal = gateway as unknown as {
      adapters: Map<string, unknown>;
      newSession(
        agentId: string,
        opts: { cwd: string; admissionSignal?: AbortSignal },
      ): Promise<{ executionId: string }>;
    };
    internal.adapters.set("codex", {
      agentId: "codex",
      dispose: async () => {},
      newSession: async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      }),
    });

    const controller = new AbortController();
    await internal.newSession("codex", {
      cwd: root,
      admissionSignal: controller.signal,
    });
    expect(observedSignal).toBe(controller.signal);

    await gateway.dispose();
  });

  it("surfaces a queue-cancelled admission as lifecycle-superseded, not a boundary defect", async () => {
    // The chat was closed while its admission sat in the gate queue. Nothing
    // was built and nothing failed — the renderer must route this exactly like
    // losing the conversation-bind race (a non-event), never as an
    // auth/protocol failure with remediation advice.
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-admission-"));
    temporaryDirectories.push(root);
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        prepareError: new AdmissionCancelledError(),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const internal = gateway as unknown as {
      adapters: Map<string, unknown>;
      newSession(
        agentId: string,
        opts: { cwd: string },
      ): Promise<{ executionId: string }>;
    };
    internal.adapters.set("codex", {
      agentId: "codex",
      dispose: async () => {},
      newSession: async () => {
        throw new Error("must never reach the adapter");
      },
    });

    const failure = await internal
      .newSession("codex", { cwd: root })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentFailureError);
    expect((failure as AgentFailureError).failure.kind).toBe(
      "lifecycle-superseded",
    );

    await gateway.dispose();
  });
});
