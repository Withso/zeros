import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import type {
  BoundaryRequest,
  PreparedBoundary,
} from "../containment/types";
import type { ProviderBinding } from "@zeros/protocol/identities";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

function gatewayWith(adapter: AgentAdapter) {
  const gateway = new AgentGateway({
    projectRoot: "/tmp",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  }) as unknown as {
    adapters: Map<string, AgentAdapter>;
    executionToAgent: Map<string, string>;
    newSession(
      agentId: string,
      opts: {
        cwd: string;
        onExecutionCreated?: (executionId: string) => void;
      },
    ): Promise<{ executionId: string }>;
    loadSession(
      agentId: string,
      binding: ProviderBinding,
      opts: {
        cwd: string;
        onExecutionCreated?: (executionId: string) => void;
      },
    ): Promise<{
      executionId?: string;
      providerBinding?: ProviderBinding;
    }>;
    forkProviderBinding(
      agentId: string,
      binding: ProviderBinding,
      opts: { cwd: string },
    ): Promise<ProviderBinding>;
    generateTitle(
      agentId: string,
      opts: {
        model: string;
        systemPrompt: string;
        prompt: string;
        env?: Record<string, string>;
      },
    ): Promise<{ title: string | null; error?: string }>;
  };
  gateway.adapters.set(adapter.agentId, adapter);
  return gateway;
}

describe("AgentGateway identity lifecycle", () => {
  it("contains a short-lived account-details provider runtime", async () => {
    let preparedRequest: BoundaryRequest | undefined;
    let receivedBoundary: PreparedBoundary | undefined;
    const gateway = new AgentGateway({
      projectRoot: "/tmp",
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => {
          preparedRequest = request;
        },
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      fetchAccountInfo(
        authenticated: Set<string>,
      ): Promise<Map<string, { provider?: string }>>;
    };
    gateway.adapters.set(
      "claude",
      {
        agentId: "claude",
        getAccountInfo: async (opts?: {
          executionBoundary?: PreparedBoundary;
        }) => {
          receivedBoundary = opts?.executionBoundary;
          return { provider: "Claude" } as never;
        },
      } as unknown as AgentAdapter,
    );

    const accounts = await gateway.fetchAccountInfo(new Set(["claude"]));

    expect(accounts.get("claude")).toEqual({ provider: "Claude" });
    expect(preparedRequest).toMatchObject({
      actor: "agent-code",
      providerId: "claude",
      cwd: "/tmp",
    });
    expect(receivedBoundary).toBeDefined();
    expect(() =>
      receivedBoundary!.wrapSpawn({
        command: process.execPath,
        args: ["--version"],
        cwd: "/tmp",
        env: {},
      }),
    ).toThrow(/revoked/);
  });

  it("prepares and retires a ZSR boundary for a one-shot title process", async () => {
    let preparedRequest: BoundaryRequest | undefined;
    let receivedBoundary: PreparedBoundary | undefined;
    const root = "/tmp";
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => {
          preparedRequest = request;
        },
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      generateTitle(
        agentId: string,
        opts: {
          model: string;
          systemPrompt: string;
          prompt: string;
          env?: Record<string, string>;
        },
      ): Promise<{ title: string | null; error?: string }>;
    };
    gateway.adapters.set("future-agent", {
      agentId: "future-agent",
      generateText: async (opts) => {
        receivedBoundary = opts.executionBoundary;
        return "Contained title";
      },
    } as AgentAdapter);

    const toolchain = await mkdtemp(
      path.join(os.tmpdir(), "zeros-title-toolchain-"),
    );
    await symlink(process.execPath, path.join(toolchain, "docker"));

    try {
      await expect(
        gateway.generateTitle("future-agent", {
          model: "model-1",
          systemPrompt: "Title this conversation",
          prompt: "Hello",
          env: {
            PATH: toolchain,
            TEST_TITLE_CREDENTIAL: "credential",
          },
        }),
      ).resolves.toEqual({ title: "Contained title" });
    } finally {
      await rm(toolchain, { recursive: true, force: true });
    }
    expect(preparedRequest).toMatchObject({
      actor: "agent-code",
      providerId: "future-agent",
      cwd: root,
      workspaceRoot: root,
    });
    expect(receivedBoundary).toBeDefined();
    expect(preparedRequest?.containerWorkflowExpected).toBeUndefined();
    expect(() =>
      receivedBoundary!.wrapSpawn({
        command: process.execPath,
        args: ["--version"],
        cwd: root,
        env: {},
      }),
    ).toThrow(/revoked/);
  });

  it("holds every later admission when a one-shot boundary cannot prove teardown", async () => {
    const gateway = new AgentGateway({
      projectRoot: "/tmp",
      executionBoundary: testExecutionBoundary({
        stopError: new Error("transient boundary teardown proof failed"),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      generateTitle(
        agentId: string,
        opts: {
          model: string;
          systemPrompt: string;
          prompt: string;
        },
      ): Promise<{ title: string | null; error?: string }>;
      newSession(
        agentId: string,
        opts: { cwd: string },
      ): Promise<{ executionId: string }>;
    };
    gateway.adapters.set("future-agent", {
      agentId: "future-agent",
      generateText: async () => "must not be published",
      newSession: async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      }),
    } as unknown as AgentAdapter);

    await expect(
      gateway.generateTitle("future-agent", {
        model: "model-1",
        systemPrompt: "Title this conversation",
        prompt: "Hello",
      }),
    ).resolves.toEqual({
      title: null,
      error: "transient boundary teardown proof failed",
    });
    await expect(
      gateway.newSession("future-agent", { cwd: "/tmp" }),
    ).rejects.toThrow(/prior execution boundary could not be proven stopped/);
  });

  it("publishes and cleans up a newly minted route around adapter startup", async () => {
    const order: string[] = [];
    let executionId: string | undefined;
    const disposeSession = vi.fn(async () => {});
    const gateway = gatewayWith({
      agentId: "future-agent",
      newSession: async (opts: { executionId?: string }) => {
        executionId = opts.executionId;
        order.push(`adapter:${opts.executionId}`);
        return {
          session: {
            executionId: opts.executionId!,
            sessionId: opts.executionId!,
          },
          initialize: {},
        };
      },
      disposeSession,
    } as unknown as AgentAdapter);

    const created = await gateway.newSession("future-agent", {
      cwd: "/tmp",
      onExecutionCreated: (id) => order.push(`route:${id}`),
    });
    expect(order).toEqual([
      `route:${created.executionId}`,
      `adapter:${created.executionId}`,
    ]);

    const rejecting = gatewayWith({
      agentId: "rejecting-agent",
      newSession: async (opts: { executionId?: string }) => {
        executionId = opts.executionId;
        throw new Error("startup failed after allocation");
      },
      disposeSession,
    } as unknown as AgentAdapter);
    await expect(
      rejecting.newSession("rejecting-agent", { cwd: "/tmp" }),
    ).rejects.toThrow("startup failed after allocation");
    expect(disposeSession).toHaveBeenCalledWith(executionId);

    const routeDispose = vi.fn(async () => {});
    const routeAdapterStart = vi.fn();
    const routeRejecting = gatewayWith({
      agentId: "route-rejecting-agent",
      newSession: routeAdapterStart,
      disposeSession: routeDispose,
    } as unknown as AgentAdapter);
    await expect(
      routeRejecting.newSession("route-rejecting-agent", {
        cwd: "/tmp",
        onExecutionCreated: () => {
          throw new Error("route publication rejected");
        },
      }),
    ).rejects.toThrow("route publication rejected");
    expect(routeAdapterStart).not.toHaveBeenCalled();
    expect(routeDispose).toHaveBeenCalledOnce();
  });

  it("mints a new execution route while preserving the provider binding", async () => {
    let receivedExecutionId: string | undefined;
    let receivedBinding: ProviderBinding | undefined;
    const adapter = {
      agentId: "future-agent",
      loadSession: async (opts: {
        executionId?: string;
        providerBinding?: ProviderBinding;
      }) => {
        receivedExecutionId = opts.executionId;
        receivedBinding = opts.providerBinding;
        return { providerBinding: opts.providerBinding };
      },
    } as unknown as AgentAdapter;
    const gateway = gatewayWith(adapter);
    const binding: ProviderBinding = {
      version: 1,
      providerId: "future-agent",
      kind: "native",
      resumeId: "provider-conversation-1",
    };

    const loaded = await gateway.loadSession("future-agent", binding, {
      cwd: "/tmp",
    });

    expect(receivedBinding).toEqual(binding);
    expect(receivedExecutionId).toBeTruthy();
    expect(receivedExecutionId).not.toBe(binding.resumeId);
    expect(loaded.executionId).toBe(receivedExecutionId);
    expect(loaded.providerBinding).toEqual(binding);
    expect(gateway.executionToAgent.get(receivedExecutionId!)).toBe(
      "future-agent",
    );
  });

  it("publishes the minted route before the adapter can emit during resume", async () => {
    const order: string[] = [];
    const adapter = {
      agentId: "future-agent",
      loadSession: async (opts: { executionId?: string }) => {
        order.push(`adapter:${opts.executionId}`);
        return {};
      },
    } as unknown as AgentAdapter;
    const gateway = gatewayWith(adapter);
    const binding: ProviderBinding = {
      version: 1,
      providerId: "future-agent",
      kind: "native",
      resumeId: "provider-conversation-1",
    };

    const loaded = await gateway.loadSession("future-agent", binding, {
      cwd: "/tmp",
      onExecutionCreated: (executionId) => {
        order.push(`route:${executionId}`);
      },
    });

    expect(order).toEqual([
      `route:${loaded.executionId}`,
      `adapter:${loaded.executionId}`,
    ]);
  });

  it("disposes the minted adapter execution when resume throws", async () => {
    let requestedExecutionId: string | undefined;
    const disposeSession = vi.fn(async () => {});
    const gateway = gatewayWith({
      agentId: "future-agent",
      loadSession: async (opts: { executionId?: string }) => {
        requestedExecutionId = opts.executionId;
        throw new Error("resume failed after allocation");
      },
      disposeSession,
    } as unknown as AgentAdapter);

    await expect(
      gateway.loadSession(
        "future-agent",
        {
          version: 1,
          providerId: "future-agent",
          kind: "native",
          resumeId: "provider-conversation-1",
        },
        { cwd: "/tmp" },
      ),
    ).rejects.toThrow("resume failed after allocation");

    expect(disposeSession).toHaveBeenCalledWith(requestedExecutionId);
  });

  it("rejects a binding owned by another provider", async () => {
    const gateway = gatewayWith({
      agentId: "future-agent",
    } as AgentAdapter);
    await expect(
      gateway.loadSession(
        "future-agent",
        {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "thread-1",
        },
        { cwd: "/tmp" },
      ),
    ).rejects.toMatchObject({
      failure: { kind: "protocol-error", stage: "loadSession" },
    });
  });

  it("rejects an adapter that replaces the Zeros execution during resume", async () => {
    const disposeSession = vi.fn(async () => {});
    let requestedExecutionId: string | undefined;
    const gateway = gatewayWith({
      agentId: "future-agent",
      loadSession: async (opts: { executionId?: string }) => {
        requestedExecutionId = opts.executionId;
        return { executionId: "provider-owned-route" };
      },
      disposeSession,
    } as unknown as AgentAdapter);

    await expect(
      gateway.loadSession(
        "future-agent",
        {
          version: 1,
          providerId: "future-agent",
          kind: "native",
          resumeId: "provider-conversation-1",
        },
        { cwd: "/tmp" },
      ),
    ).rejects.toMatchObject({
      failure: { kind: "protocol-error", stage: "loadSession" },
    });
    expect(disposeSession).toHaveBeenCalledWith(requestedExecutionId);
    expect(disposeSession).not.toHaveBeenCalledWith("provider-owned-route");
    expect(disposeSession).toHaveBeenCalledTimes(1);
  });

  it("forks an opaque provider binding without creating a Zeros execution", async () => {
    const source: ProviderBinding = {
      version: 1,
      providerId: "future-agent",
      kind: "native",
      resumeId: "provider-source",
      scopeId: "provider-lineage",
    };
    const forked: ProviderBinding = {
      ...source,
      resumeId: "provider-fork",
    };
    const forkProviderBinding = vi.fn(async () => ({
      providerBinding: forked,
    }));
    const gateway = gatewayWith({
      agentId: "future-agent",
      forkProviderBinding,
    } as unknown as AgentAdapter);

    await expect(
      gateway.forkProviderBinding("future-agent", source, {
        cwd: "/tmp",
      }),
    ).resolves.toEqual(forked);
    expect(forkProviderBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        providerBinding: source,
        cwd: "/tmp",
      }),
    );
    expect(gateway.executionToAgent.size).toBe(0);
  });

  it("rejects unsupported forks and provider-owned binding substitution", async () => {
    const source: ProviderBinding = {
      version: 1,
      providerId: "future-agent",
      kind: "native",
      resumeId: "provider-source",
    };
    const unsupported = gatewayWith({
      agentId: "future-agent",
    } as AgentAdapter);
    await expect(
      unsupported.forkProviderBinding("future-agent", source, { cwd: "/tmp" }),
    ).rejects.toMatchObject({
      failure: { kind: "protocol-error", stage: "forkSession" },
    });

    const substituting = gatewayWith({
      agentId: "future-agent",
      forkProviderBinding: async () => ({
        providerBinding: {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "foreign-thread",
        },
      }),
    } as unknown as AgentAdapter);
    await expect(
      substituting.forkProviderBinding("future-agent", source, { cwd: "/tmp" }),
    ).rejects.toMatchObject({
      failure: { kind: "protocol-error", stage: "forkSession" },
    });
  });
});
