import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { isSelectableAgent } from "../agent-runnable";
const mock = vi.hoisted(() => ({ request: vi.fn(), fetch: vi.fn(), refreshListeners: new Set<(scope?: ReadonlySet<string>) => void>() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ request: mock.request }),
}));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => null,
  subscribeCloudWorkspaces: () => () => {},
  subscribeCloudWorkspaceRefresh: (listener: (scope?: ReadonlySet<string>) => void) => { mock.refreshListeners.add(listener); return () => mock.refreshListeners.delete(listener); },
}));
import {
  clearCloudAgentRegistry,
  hasConfirmedWorkspaceAgents,
  modelsForWorkspaceAgent,
  useWorkspaceAgents,
  warmCloudAgentRegistry,
  workspaceAgentsSnapshot,
} from "../workspace-agent-registry";
import { refreshAgents } from "../agents-cache";
import { modelsForAgent } from "../model-catalog";
const a =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const b =
  "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
const workerAgents: BridgeRegistryAgent[] = ["codex", "claude", "cursor"].map(id => ({
  id, name: id, version: "1", description: `${id} cloud agent`, distribution: {}, installed: true, authenticated: id !== "cursor",
}));
beforeEach(() => {
  vi.clearAllMocks();
  clearCloudAgentRegistry();
  vi.stubGlobal("fetch", mock.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("workspace agent registry", () => {
  // Regression: cloud discovery also called the retired v1 credential route,
  // so the whole read failed and a v2 workspace had no agents to send to.
  it("lists a cloud workspace's agents from its worker without any control-plane credential read", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: workerAgents });
    const agents = await warmCloudAgentRegistry(a);
    expect(agents).toEqual(workerAgents);
    expect(agents.map(agent => agent.authenticated)).toEqual([true, true, false]);
    expect(mock.request).toHaveBeenCalledWith({ type: "AGENT_LIST_AGENTS", cwd: a }, 30_000);
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it("offers a cloud agent the same models as the provider catalog", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: workerAgents });
    const [codex] = await warmCloudAgentRegistry(a);
    expect(modelsForWorkspaceAgent(codex!, null)).toEqual(modelsForAgent("codex", null));
  });
  it("refreshes only the signaled organization while retaining another owner's confirmed discovery", async () => {
    const c = "cloud://44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555";
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }] });
    await Promise.all([warmCloudAgentRegistry(a), warmCloudAgentRegistry(c)]);
    const retained = workspaceAgentsSnapshot(c), before = workspaceAgentsSnapshot(a);
    for (const listener of mock.refreshListeners) listener(new Set(["11111111-1111-4111-8111-111111111111"]));
    expect(workspaceAgentsSnapshot(a)).toBe(before); expect(workspaceAgentsSnapshot(c)).toBe(retained);
    await Promise.all([warmCloudAgentRegistry(a), warmCloudAgentRegistry(c)]);
    expect(mock.request).toHaveBeenCalledTimes(3);
    expect(workspaceAgentsSnapshot(c)).toBe(retained);
  });
  it("preserves local registry and model choices while a cloud workspace is discovered", async () => {
    const local: BridgeRegistryAgent[] = ["claude", "codex", "cursor"].map(id => ({
      id, name: id, version: "1", description: "Local provider", distribution: {},
      installed: true, authenticated: id !== "cursor",
    }));
    await refreshAgents(async () => local);
    const models = local.filter(isSelectableAgent).map(agent => modelsForAgent(agent.id, null));
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents: workerAgents });
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
    }
    clearCloudAgentRegistry();
    expect(workspaceAgentsSnapshot("/local/personal")).toBe(local);
    expect(mock.request).toHaveBeenCalledOnce();
  });
  it("deduplicates exact workspace reads and keeps each workspace's registry separate", async () => {
    mock.request.mockImplementation(async (request: { cwd: string }) => ({
      type: "AGENT_AGENTS_LIST",
      agents: [{ id: "codex", installed: true, authenticated: request.cwd === a }],
    }));
    await Promise.all([warmCloudAgentRegistry(a), warmCloudAgentRegistry(a), warmCloudAgentRegistry(b)]);
    expect(mock.request.mock.calls.map(([request]) => request.cwd)).toEqual([a, b]);
    expect(workspaceAgentsSnapshot(a)?.map(agent => agent.authenticated)).toEqual([true]);
    expect(workspaceAgentsSnapshot(b)?.map(agent => agent.authenticated)).toEqual([false]);
  });
  it("rejects a malformed registry reply", async () => {
    mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST" });
    await expect(warmCloudAgentRegistry(a)).rejects.toThrow("Cloud agent registry is unavailable");
    expect(workspaceAgentsSnapshot(a)).toBeNull();
  });
  it("does not publish a late snapshot after sign-out", async () => {
    let resolve!: (value: unknown) => void;
    mock.request.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = warmCloudAgentRegistry(a);
    clearCloudAgentRegistry();
    resolve({ type: "AGENT_AGENTS_LIST", agents: [{ id: "codex", installed: true }] });
    await pending;
    expect(workspaceAgentsSnapshot(a)).toBeNull();
  });
});
