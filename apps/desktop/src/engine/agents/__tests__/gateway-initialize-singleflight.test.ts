import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter, InitializeResponse } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import * as providerEnv from "../../settings/provider-env";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function gatewayWith(adapter: AgentAdapter): AgentGateway {
  const gateway = new AgentGateway({
    projectRoot: "/tmp/zeros-initialize-singleflight",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
  (
    gateway as unknown as { adapters: Map<string, AgentAdapter> }
  ).adapters.set(adapter.agentId, adapter);
  return gateway;
}

const gateways: AgentGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()));
  vi.restoreAllMocks();
});

describe("gateway agent initialization single-flight", () => {
  it("invalidates populated models and pending initialization when authentication changes", async () => {
    const config = vi
      .spyOn(providerEnv, "applyUserProviderConfig")
      .mockReturnValue({ env: { OPENAI_API_KEY: "fixture-a" } });
    const old = deferred<InitializeResponse>();
    const newModels: InitializeResponse = {
      protocolVersion: 1,
      _meta: { models: [{ value: "model", label: "Model", supportsFast: false }] },
    };
    const initialize = vi
      .fn<() => Promise<InitializeResponse>>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(newModels);
    const gateway = gatewayWith({
      agentId: "codex",
      initialize,
      dispose: async () => {},
    } as unknown as AgentAdapter);
    gateways.push(gateway);
    const a = gateway.initializeAgent("codex");
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    config.mockReturnValue({ env: { OPENAI_API_KEY: "fixture-b" } });
    const b = gateway.initializeAgent("codex");
    old.resolve({
      protocolVersion: 1,
      _meta: { models: [{ value: "model", label: "Model", supportsFast: true }] },
    });
    expect((await b)._meta?.models).toEqual(newModels._meta?.models);
    await a;
    expect((await gateway.initializeAgent("codex"))._meta?.models).toEqual(
      newModels._meta?.models,
    );
    config.mockReturnValue({ env: { OPENAI_API_KEY: "fixture-c" } });
    await gateway.initializeAgent("codex");
    expect(initialize).toHaveBeenCalledTimes(3);
  });
  it("shares concurrent initialization requests for one provider", async () => {
    const pending = deferred<InitializeResponse>();
    const initialize = vi.fn(() => pending.promise);
    const gateway = gatewayWith({
      agentId: "contained",
      initialize,
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentAdapter);
    gateways.push(gateway);

    const first = gateway.initializeAgent("contained");
    const second = gateway.initializeAgent("contained");
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));

    pending.resolve({
      protocolVersion: 1,
      _meta: { models: [{ value: "fast", label: "Fast" }] },
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(firstResult._meta?.models).toEqual([
      { value: "fast", label: "Fast" },
    ]);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("clears a rejected flight so a later request can retry", async () => {
    const initialize = vi
      .fn<() => Promise<InitializeResponse>>()
      .mockRejectedValueOnce(new Error("provider boot failed"))
      .mockResolvedValueOnce({ protocolVersion: 1 });
    const gateway = gatewayWith({
      agentId: "contained",
      initialize,
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentAdapter);
    gateways.push(gateway);

    await expect(gateway.initializeAgent("contained")).rejects.toThrow(
      "provider boot failed",
    );
    await expect(
      gateway.initializeAgent("contained"),
    ).resolves.toHaveProperty("agentCapabilities");

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
