import { beforeEach, describe, expect, it, vi } from "vitest";
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
  modelsForWorkspaceAgent,
  warmCloudAgentRegistry,
  workspaceAgentsSnapshot,
} from "../workspace-agent-registry";
const a =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const b =
  "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  vi.clearAllMocks();
  clearCloudAgentRegistry();
});
describe("workspace agent registry", () => {
  it("keeps an old runtime visible with an actionable upgrade flag and no selectable models", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }] });
    mock.grants.mockResolvedValue([{ kind: "codex-chatgpt", models: ["gpt-5.6-sol"], runtimeQualified: false, runtimeUpgradeRequired: true }]);
    expect((await warmCloudAgentRegistry(a))[0]).toMatchObject({
      authenticated: false, cloudModels: [], runtimeUpgradeRequired: true,
      runtimeUnavailableReason: "Update the cloud runtime to use agents",
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
