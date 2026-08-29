import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
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

function installAdapter(gateway: AgentGateway, adapter: AgentAdapter): void {
  const internal = gateway as unknown as {
    adapters: Map<string, AgentAdapter>;
  };
  internal.adapters.set(adapter.agentId, adapter);
}

describe("AgentGateway provider one-shots", () => {
  it("contains and retires key validation without reflecting the candidate secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-key-check-"));
    temporaryDirectories.push(root);
    const requests: BoundaryRequest[] = [];
    const stopped: BoundaryRequest[] = [];
    const candidate = "candidate-secret-that-must-not-escape";
    const validateApiKey = vi.fn(
      async (_apiKey: string, _opts?: unknown) => ({
        ok: false,
        error: `provider rejected ${candidate}`,
      }),
    );
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => requests.push(request),
        onStop: (request) => stopped.push(request),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    installAdapter(
      gateway,
      {
        agentId: "cursor",
        validateApiKey,
        dispose: async () => {},
      } as unknown as AgentAdapter,
    );

    const result = await gateway.validateProviderKey("cursor", candidate);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actor: "agent-code",
      providerId: "cursor",
      backendHint: "zeros-srt",
    });
    expect(requests[0]?.executionId).toMatch(/^validate-key-cursor-/);
    // Pooled: the boundary stays warm for the next identical one-shot instead of
    // being proven torn down per call (containment/utility-boundary-pool.ts).
    expect(stopped).toEqual([]);
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(validateApiKey.mock.calls[0]?.[1]).toMatchObject({
      cwd: root,
      executionBoundary: expect.objectContaining({
        generation: expect.stringMatching(/^test-/),
      }),
      env: expect.objectContaining({ CURSOR_API_KEY: candidate }),
    });
    expect(result).toEqual({
      ok: false,
      error: "provider rejected [redacted]",
    });

    // A second identical validation reuses the warm boundary — one admission
    // total, still exactly one proven teardown, taken at dispose.
    await gateway.validateProviderKey("cursor", candidate);
    expect(requests).toHaveLength(1);
    expect(validateApiKey).toHaveBeenCalledTimes(2);

    await gateway.dispose();
    expect(stopped).toEqual(requests);
  });

  it("contains and retires provider session discovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-list-sessions-"));
    temporaryDirectories.push(root);
    const requests: BoundaryRequest[] = [];
    const stopped: BoundaryRequest[] = [];
    const listSessions = vi.fn(async (_opts: unknown) => ({ sessions: [] }));
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => requests.push(request),
        onStop: (request) => stopped.push(request),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    installAdapter(
      gateway,
      {
        agentId: "cursor",
        listSessions,
        dispose: async () => {},
      } as unknown as AgentAdapter,
    );

    await expect(
      gateway.listSessions("cursor", { cwd: root }),
    ).resolves.toEqual({ sessions: [] });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actor: "agent-code",
      providerId: "cursor",
      cwd: root,
      backendHint: "zeros-srt",
    });
    expect(requests[0]?.executionId).toMatch(/^list-sessions-cursor-/);
    expect(stopped).toEqual([]);
    expect(listSessions.mock.calls[0]?.[0]).toMatchObject({
      cwd: root,
      executionBoundary: expect.objectContaining({
        generation: expect.stringMatching(/^test-/),
      }),
    });

    await gateway.dispose();
    expect(stopped).toEqual(requests);
  });

  it("retires a pooled one-shot boundary instead of reusing it after a failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-oneshot-fail-"));
    temporaryDirectories.push(root);
    const requests: BoundaryRequest[] = [];
    const stopped: BoundaryRequest[] = [];
    const listSessions = vi
      .fn(async (_opts: unknown) => ({ sessions: [] }))
      .mockRejectedValueOnce(new Error("provider blew up"));
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => requests.push(request),
        onStop: (request) => stopped.push(request),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    installAdapter(
      gateway,
      {
        agentId: "cursor",
        listSessions,
        dispose: async () => {},
      } as unknown as AgentAdapter,
    );

    await expect(
      gateway.listSessions("cursor", { cwd: root }),
    ).rejects.toThrow();
    // The failed operation's boundary is proven stopped immediately — a boundary
    // whose one-shot threw is never handed to the next caller.
    expect(requests).toHaveLength(1);
    expect(stopped).toEqual(requests);

    await expect(
      gateway.listSessions("cursor", { cwd: root }),
    ).resolves.toEqual({ sessions: [] });
    expect(requests).toHaveLength(2);

    await gateway.dispose();
    expect(stopped).toEqual(requests);
  });
});
