import { describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import type { ProviderBinding } from "@zeros/protocol/identities";

function gatewayWith(adapter: AgentAdapter) {
  const gateway = new AgentGateway({
    projectRoot: "/tmp",
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
  };
  gateway.adapters.set(adapter.agentId, adapter);
  return gateway;
}

describe("AgentGateway identity lifecycle", () => {
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
});
