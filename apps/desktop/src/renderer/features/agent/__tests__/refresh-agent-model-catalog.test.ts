import { describe, expect, it, vi } from "vitest";
import type { InitializeResponse } from "../../../platform/bridge/agent-events";
import { refreshAgentModelCatalog, type AgentModelCatalogOwner } from "../refresh-agent-model-catalog";

const catalog = (values: string[], scoped = true): InitializeResponse => ({
  protocolVersion: 1, agentCapabilities: { steering: true }, _meta: { modelsDynamic: true, modelsAccountScoped: scoped,
    models: values.map(value => ({ value, label: value })) },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("exact-owner model catalog refresh", () => {
  it.each(["local", "organization-local", "cloud"])("restores steering metadata after a %s conversation is reopened", async placement => {
    const owner: AgentModelCatalogOwner = { bridge: {}, key: `${placement}/chat/execution`, initialize: null };
    const initialize: InitializeResponse = { protocolVersion: 1, agentCapabilities: { steering: true } };
    const publish = vi.fn(), request = vi.fn(async () => initialize);
    await refreshAgentModelCatalog({ current: () => owner, request, publish });
    expect(request).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledExactlyOnceWith(initialize);
  });

  it("fills missing capabilities without requiring a dynamic model catalog", async () => {
    const owner = { bridge: {}, key: "cloud/chat/execution", initialize: { protocolVersion: 1 } };
    const initialize: InitializeResponse = { protocolVersion: 1, agentCapabilities: { steering: true } };
    const publish = vi.fn();
    await refreshAgentModelCatalog({ current: () => owner, request: async () => initialize, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(initialize);
  });

  it.each([{ values: [] }, { values: ["previous"] }])("refreshes a populated or empty account snapshot ($values)", async ({ values }) => {
    const owner = { bridge: {}, key: "local/account/chat/execution", initialize: catalog(values) };
    const replacement = catalog([]), publish = vi.fn(), request = vi.fn(async () => replacement);
    await refreshAgentModelCatalog({ current: () => owner, request, publish });
    expect(request).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledExactlyOnceWith(replacement);
  });

  it.each(["account", "workspace", "execution", "bridge", "initialize", "deleted"])("withholds a late result after %s changes", async changed => {
    let owner: AgentModelCatalogOwner | null = { bridge: {}, key: "cloud/account/workspace/chat/execution", initialize: catalog([], false) };
    const response = deferred<InitializeResponse>(), publish = vi.fn();
    const work = refreshAgentModelCatalog({ current: () => owner, request: () => response.promise, publish });
    if (changed === "deleted") owner = null;
    else if (changed === "bridge") owner = { ...owner!, bridge: {} };
    else if (changed === "initialize") owner = { ...owner!, initialize: catalog([]) };
    else owner = { ...owner!, key: `${owner!.key}/${changed}-replacement` };
    response.resolve(catalog(["stale-account"]));
    await work;
    expect(publish).not.toHaveBeenCalled();
  });

  it("shares an in-flight read for one owner without merging another execution", async () => {
    const owner = { bridge: {}, key: "local/chat/execution", initialize: catalog([]) };
    const response = deferred<InitializeResponse>(), request = vi.fn(() => response.promise), publish = vi.fn();
    const opts = { current: () => owner, request, publish };
    const first = refreshAgentModelCatalog(opts), second = refreshAgentModelCatalog(opts);
    const other = refreshAgentModelCatalog({ ...opts, current: () => ({ ...owner, key: "cloud/chat/other" }) });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    response.resolve(catalog(["current"]));
    await Promise.all([first, second, other]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("retains confirmed metadata on failure and leaves legacy populated catalogs alone", async () => {
    const owner = { bridge: {}, key: "local/chat", initialize: catalog(["current"]) };
    const request = vi.fn(async () => { throw new Error("offline"); }), publish = vi.fn();
    await refreshAgentModelCatalog({ current: () => owner, request, publish });
    expect(publish).not.toHaveBeenCalled();
    expect(owner.initialize._meta?.models?.[0].value).toBe("current");
    owner.initialize = catalog(["legacy"], false);
    await refreshAgentModelCatalog({ current: () => owner, request, publish });
    expect(request).toHaveBeenCalledOnce();
  });
});
