import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { isSelectableAgent } from "../agent-runnable";
const mock = vi.hoisted(() => ({ request: vi.fn(), grants: vi.fn(), refreshListeners: new Set<() => void>() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ request: mock.request }),
}));
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAgentDelegations: mock.grants,
}));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => null,
  subscribeCloudWorkspaces: () => () => {},
  subscribeCloudWorkspaceRefresh: (listener: () => void) => { mock.refreshListeners.add(listener); return () => mock.refreshListeners.delete(listener); },
}));
import {
  clearCloudAgentRegistry,
  hasConfirmedWorkspaceAgents,
  useWorkspaceAgents,
  reportCloudAgentRuntimeUpgrade,
  modelsForWorkspaceAgent,
  warmCloudAgentRegistry,
  workspaceAgentsSnapshot,
} from "../workspace-agent-registry";
import { refreshAgents } from "../agents-cache";
import { modelsForAgent } from "../model-catalog";
const a =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const b =
  "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  vi.clearAllMocks();
  clearCloudAgentRegistry();
});
describe("workspace agent registry", () => {
  it("preserves local registry and model choices while cloud qualification changes", async () => {
    const local: BridgeRegistryAgent[] = ["claude", "codex", "cursor"].map(id => ({
      id, name: id, version: "1", description: "Local provider", distribution: {},
      installed: true, authenticated: id !== "cursor",
    }));
    await refreshAgents(async () => local);
    const models = local.filter(isSelectableAgent).map(agent => modelsForAgent(agent.id, null));
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: local });
    mock.grants.mockResolvedValue(local.map(agent => ({ kind: `${agent.id}-api-key`, runtimeQualified: false })));
    await warmCloudAgentRegistry(a);

    for (const folder of [null, "/local/personal", "/local/organization"]) {
      expect(workspaceAgentsSnapshot(folder)).toBe(local);
      expect(hasConfirmedWorkspaceAgents(folder)).toBe(true);
      let rendered: BridgeRegistryAgent[] | null = null;
      function LocalComposerRegistry() {
        rendered = useWorkspaceAgents(folder);
        return null;
      }
      renderToStaticMarkup(createElement(LocalComposerRegistry));
      expect(rendered).toBe(local);
      expect(workspaceAgentsSnapshot(folder)!.filter(isSelectableAgent).map(agent => modelsForWorkspaceAgent(agent, null))).toEqual(models);
      expect(local.some(agent => agent.runtimeUnavailableReason)).toBe(false);
    }
    clearCloudAgentRegistry();
    expect(workspaceAgentsSnapshot("/local/personal")).toBe(local);
    expect(mock.request).toHaveBeenCalledOnce();
    expect(mock.grants).toHaveBeenCalledOnce();
  });

  it("publishes an exact-workspace rejection immediately and refreshes durable discovery", async () => {
    const local = [{ id: "codex", installed: true, authenticated: true }] as never;
    await refreshAgents(async () => local);
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: local });
    mock.grants.mockResolvedValue([{ kind: "codex-chatgpt", runtimeQualified: true, models: ["gpt-5.6-sol"] }]);
    await Promise.all([warmCloudAgentRegistry(a), warmCloudAgentRegistry(b)]);
    const untouched = workspaceAgentsSnapshot(b);
    let complete!: (value: unknown) => void;
    mock.grants.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    reportCloudAgentRuntimeUpgrade(a, "codex");
    expect(workspaceAgentsSnapshot(a)?.[0]).toMatchObject({ runtimeUpgradeRequired: true, authenticated: false, cloudModels: [] });
    expect(workspaceAgentsSnapshot(b)).toBe(untouched);
    expect(workspaceAgentsSnapshot("/local/workspace")).toBe(local);
    reportCloudAgentRuntimeUpgrade("/local/workspace", "codex");
    await vi.waitFor(() => expect(mock.grants).toHaveBeenCalledTimes(3));
    complete([{ kind: "codex-chatgpt", runtimeQualified: false, runtimeUpgradeRequired: true, models: ["gpt-5.6-sol"] }]);
    await warmCloudAgentRegistry(a);
    expect(workspaceAgentsSnapshot(a)?.[0].runtimeUpgradeRequired).toBe(true);
  });
  it("keeps local discovery and models unchanged while cloud grants require an upgrade", async () => {
    const local = [{ id: "codex", installed: true, authenticated: true }] as never;
    await refreshAgents(async () => local);
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: local });
    mock.grants.mockResolvedValue([{ kind: "codex-chatgpt", models: ["gpt-5.6-sol"], runtimeQualified: false, runtimeUpgradeRequired: true }]);
    await warmCloudAgentRegistry(a);
    for (const listener of mock.refreshListeners) listener();
    expect(workspaceAgentsSnapshot("/local/workspace")).toBe(local);
    expect(workspaceAgentsSnapshot("/local/workspace")![0]).not.toHaveProperty("runtimeUpgradeRequired");
    expect(modelsForWorkspaceAgent(local[0], null)).toEqual(modelsForAgent("codex", null));
    expect(mock.grants).toHaveBeenCalledTimes(1);
  });
  it("keeps an old runtime visible with an actionable upgrade flag and no selectable models", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }] });
    mock.grants.mockResolvedValue([{ kind: "codex-chatgpt", models: ["gpt-5.6-sol"], runtimeQualified: false, runtimeUpgradeRequired: true }]);
    expect((await warmCloudAgentRegistry(a))[0]).toMatchObject({
      authenticated: false, cloudModels: [], runtimeUpgradeRequired: true,
      runtimeUnavailableReason: "This workspace gets the new cloud runtime the next time it wakes",
    });
    clearCloudAgentRegistry();
    mock.grants.mockResolvedValue([
      { kind: "codex-chatgpt", models: ["gpt-5.6-sol"], runtimeQualified: false, runtimeUpgradeRequired: true },
      { kind: "codex-api-key", models: ["gpt-5.6-luna"], runtimeQualified: true, runtimeUpgradeRequired: false },
    ]);
    expect((await warmCloudAgentRegistry(a))[0]).toMatchObject({ authenticated: true, cloudModels: ["gpt-5.6-luna"], runtimeUpgradeRequired: false });
  });
  it("rechecks grants on catalog refresh while retaining the last confirmed workspace snapshot", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }] });
    mock.grants.mockResolvedValue([{ kind: "codex-chatgpt", runtimeQualified: false, models: ["gpt-5.6-luna"] }]);
    const before = await warmCloudAgentRegistry(a);
    let resolve!: (value: unknown) => void;
    mock.grants.mockReturnValue(new Promise(done => { resolve = done; }));
    for (const listener of mock.refreshListeners) listener();
    const pending = warmCloudAgentRegistry(a);
    expect(workspaceAgentsSnapshot(a)).toBe(before);
    resolve([{ kind: "codex-chatgpt", runtimeQualified: true, models: ["gpt-5.6-luna"] }]);
    await pending;
    expect(workspaceAgentsSnapshot(a)?.[0]).toMatchObject({ authenticated: true, cloudModels: ["gpt-5.6-luna"] });
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(workspaceAgentsSnapshot(b)).toBeNull();
  });
  it("offers only exact models from qualified grants, independently for each workspace", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }, { id: "claude", installed: true }] });
    mock.grants.mockImplementation(async (target) => target.workspaceId.startsWith("2222") ? [
      { kind: "codex-chatgpt", runtimeQualified: true, models: ["gpt-5.6-luna"] },
      { kind: "codex-api-key", runtimeQualified: false, models: ["gpt-6-astra"] },
      { kind: "codex-api-key", runtimeQualified: true, models: ["gpt-5.6-luna", "gpt-5.6-sol"] },
      { kind: "claude-setup-token", runtimeQualified: true, models: ["claude-opus-5[1m]"] },
    ] : [{ kind: "codex-chatgpt", runtimeQualified: true, models: ["gpt-6-astra"] }]);
    await Promise.all([warmCloudAgentRegistry(a), warmCloudAgentRegistry(b)]);
    expect(workspaceAgentsSnapshot(a)?.map(agent => agent.cloudModels)).toEqual([
      ["gpt-5.6-luna", "gpt-5.6-sol"], ["claude-opus-5[1m]"],
    ]);
    expect(workspaceAgentsSnapshot(b)?.map(agent => agent.cloudModels)).toEqual([["gpt-6-astra"], []]);
    expect(modelsForWorkspaceAgent(workspaceAgentsSnapshot(a)![0]!, null).map(model => model.value).sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(modelsForWorkspaceAgent(workspaceAgentsSnapshot(b)![1]!, null)).toEqual([]);
  });
  it("never expands an exact model grant to other context variants", () => {
    expect(modelsForWorkspaceAgent({ id: "claude", cloudModels: ["claude-opus-5"] } as never, null)).toEqual([]);
    expect(modelsForWorkspaceAgent({ id: "claude", cloudModels: ["claude-opus-5[1m]"] } as never, null).map(model => model.value)).toEqual(["claude-opus-5[1m]"]);
    expect(modelsForWorkspaceAgent({ id: "claude" } as never, null).length).toBeGreaterThan(1);
  });
  it("retains unqualified providers with a runtime reason and offers qualified account modes", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }, { id: "claude", installed: true }, { id: "cursor", installed: true }] });
    mock.grants.mockResolvedValue([{ kind: "codex-api-key", models: ["gpt-5.6-sol"], runtimeQualified: false }, { kind: "claude-api-key", models: ["claude-opus-5[1m]"], runtimeQualified: false }, { kind: "cursor-api-key", models: ["composer-2.5"], runtimeQualified: true }]);
    const agents = await warmCloudAgentRegistry(a);
    expect(agents.map(agent => agent.id)).toEqual(["codex", "claude", "cursor"]);
    expect(agents.map(agent => agent.authenticated)).toEqual([false, false, true]);
    expect(agents[0]?.runtimeUnavailableReason).toContain("runtime");
    clearCloudAgentRegistry();
    mock.grants.mockResolvedValue([{ kind: "codex-chatgpt", models: ["gpt-5.6-sol"], runtimeQualified: true }, { kind: "claude-setup-token", models: ["claude-opus-5[1m]"], runtimeQualified: true }, { kind: "cursor-api-key", models: ["composer-2.5"], runtimeQualified: true }]);
    expect((await warmCloudAgentRegistry(a)).map(agent => agent.authenticated)).toEqual([true, true, true]);
  });
  it("keeps smoke-qualified providers selectable when MCP and native capabilities are unqualified", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "cursor", installed: true }] });
    mock.grants.mockResolvedValue([{ kind: "cursor-api-key", models: ["composer-2.5"], runtimeQualified: true, mcpQualified: false }]);
    expect(await warmCloudAgentRegistry(a)).toEqual([expect.objectContaining({ id: "cursor", authenticated: true })]);
  });
  it("deduplicates exact workspace reads and keeps each workspace's grants separate", async () => {
    mock.request.mockResolvedValue({
      type: "AGENT_AGENTS_LIST",
      agents: [
        { id: "codex", installed: true },
        { id: "claude", installed: true },
      ],
    });
    mock.grants.mockImplementation(async (target) => [
      {
        models: [],
        kind: target.workspaceId.startsWith("2222")
          ? "codex-api-key"
          : "claude-api-key",
      },
    ]);
    await Promise.all([
      warmCloudAgentRegistry(a),
      warmCloudAgentRegistry(a),
      warmCloudAgentRegistry(b),
    ]);
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(mock.request.mock.calls.map(([request]) => request.cwd)).toEqual([
      a,
      b,
    ]);
    expect(
      workspaceAgentsSnapshot(a)?.map((agent) => agent.authenticated),
    ).toEqual([true, false]);
    expect(
      workspaceAgentsSnapshot(b)?.map((agent) => agent.authenticated),
    ).toEqual([false, true]);
  });
  it("does not publish a late credential snapshot after sign-out", async () => {
    let resolve!: (value: unknown) => void;
    mock.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mock.grants.mockResolvedValue([{ kind: "codex-api-key", models: ["gpt-5.6-sol"] }]);
    const pending = warmCloudAgentRegistry(a);
    clearCloudAgentRegistry();
    resolve({
      type: "AGENT_AGENTS_LIST",
      agents: [{ id: "codex", installed: true }],
    });
    await pending;
    expect(workspaceAgentsSnapshot(a)).toBeNull();
  });
});
