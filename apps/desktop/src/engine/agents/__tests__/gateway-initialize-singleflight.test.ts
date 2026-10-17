import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter, InitializeResponse } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import * as providerEnv from "../../settings/provider-env";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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

it("publishes a refreshed empty account catalog without another adapter or authority path", async () => {
  let models: Array<{ value: string; label: string }> = [{ value: "gpt-6-astra", label: "Astra" }];
  const initialize = vi.fn(async () => ({ protocolVersion: 1, _meta: { modelsDynamic: true, modelsAccountScoped: true, models } }));
  const gateway = gatewayWith({ agentId: "contained", initialize, dispose: async () => {} } as unknown as AgentAdapter);
  gateways.push(gateway);
  await gateway.initializeAgent("contained");
  models = [];
  const [first, second] = await Promise.all([gateway.initializeAgent("contained"), gateway.initializeAgent("contained")]);
  expect(first).toBe(second);
  expect(first._meta?.models).toEqual([]);
  expect(initialize).toHaveBeenCalledTimes(2);
});

const gateways: AgentGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()));
  vi.restoreAllMocks();
});

describe("gateway agent initialization single-flight", () => {
  it("reads a session catalog without publishing it as the provider-wide account snapshot", async () => {
    const initialize = vi.fn(async () => ({ protocolVersion: 1 }));
    const scoped = { protocolVersion: 1, _meta: { modelsAccountScoped: true, models: [{ value: "account-model", label: "Model" }] } };
    const initializeSession = vi.fn(async (id: string) => id === "owned" ? scoped : { protocolVersion: 1 });
    const gateway = gatewayWith({ agentId: "contained", initialize, initializeSession, dispose: async () => {} } as unknown as AgentAdapter);
    gateways.push(gateway);
    expect(await gateway.initializeAgent("contained", "owned")).toMatchObject(scoped);
    expect(initializeSession).toHaveBeenCalledExactlyOnceWith("owned");
    expect(gateway.agentInitializeSnapshot("contained")).toBeNull();
    expect((await gateway.initializeAgent("contained"))._meta?.models).toBeUndefined();
  });
  it("reads confirmed capabilities without starting an adapter or returning another auth snapshot", async () => {
    const config = vi.spyOn(providerEnv, "applyUserProviderConfig").mockReturnValue({ env: { OPENAI_API_KEY: "fixture-a" } });
    const initialize = vi.fn(async () => ({ protocolVersion: 1 }));
    const gateway = gatewayWith({ agentId: "codex", initialize, dispose: async () => {} } as unknown as AgentAdapter);
    gateways.push(gateway);
    expect(gateway.agentInitializeSnapshot("codex")).toBeNull();
    expect(initialize).not.toHaveBeenCalled();
    const confirmed = await gateway.initializeAgent("codex");
    expect(gateway.agentInitializeSnapshot("codex")).toBe(confirmed);
    expect(initialize).toHaveBeenCalledOnce();
    config.mockReturnValue({ env: { OPENAI_API_KEY: "fixture-b" } });
    expect(gateway.agentInitializeSnapshot("codex")).toBeNull();
    expect(initialize).toHaveBeenCalledOnce();
  });
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

  it("keeps a successor auth flight shared when the stale initialization rejects", async () => {
    const config = vi.spyOn(providerEnv, "applyUserProviderConfig").mockReturnValue({ env: { OPENAI_API_KEY: "fixture-a" } });
    const old = deferred<InitializeResponse>(), current = deferred<InitializeResponse>();
    const initialize = vi.fn<() => Promise<InitializeResponse>>().mockReturnValueOnce(old.promise).mockReturnValue(current.promise);
    const gateway = gatewayWith({ agentId: "codex", initialize, dispose: async () => {} } as unknown as AgentAdapter);
    gateways.push(gateway);
    const stale = gateway.initializeAgent("codex");
    const staleRejection = expect(stale).rejects.toThrow("stale authentication failed");
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    config.mockReturnValue({ env: { OPENAI_API_KEY: "fixture-b" } });
    const successor = gateway.initializeAgent("codex");
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(2));
    old.reject(new Error("stale authentication failed"));
    await staleRejection;
    const joined = gateway.initializeAgent("codex");
    current.resolve({ protocolVersion: 1, _meta: { models: [{ value: "current", label: "Current" }] } });
    const [first, second] = await Promise.all([successor, joined]);
    expect(first).toBe(second);
    expect(first._meta?.models).toEqual([{ value: "current", label: "Current" }]);
    expect(gateway.agentInitializeSnapshot("codex")).toBe(first);
    expect(initialize).toHaveBeenCalledTimes(2);
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

describe("the current account catalog", () => {
  it("re-reads an adapter that republished its models after the cached first read", async () => {
    let selectable = true;
    const initialize = vi.fn(async () => ({
      protocolVersion: 1,
      _meta: { models: [{ value: "grok-4.7", label: "Grok 4.7", selectable }] },
    }));
    const gateway = gatewayWith({ agentId: "cursor-like", initialize, dispose: async () => {} } as unknown as AgentAdapter);
    gateways.push(gateway);
    await gateway.initializeAgent("cursor-like");
    // The account refuses the model; the adapter republishes its catalog.
    selectable = false;
    const current = await gateway.currentAgentInitialize("cursor-like");
    expect(current?._meta?.models?.[0]?.selectable).toBe(false);
    // The account snapshot other readers use is current too.
    expect(gateway.agentInitializeSnapshot("cursor-like")?._meta?.models?.[0]?.selectable).toBe(false);
  });

  it("answers from the snapshot for an agent without a running adapter", async () => {
    const gateway = gatewayWith({ agentId: "other", initialize: vi.fn(), dispose: async () => {} } as unknown as AgentAdapter);
    gateways.push(gateway);
    expect(await gateway.currentAgentInitialize("missing")).toBeNull();
  });
});
