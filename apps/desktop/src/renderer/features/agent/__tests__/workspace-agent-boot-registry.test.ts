import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { isSelectableAgent } from "../agent-runnable";

const binding = { mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1, generation: 2, engineInstanceId: "77777777-7777-4777-8777-777777777777", status: "current" };
const mock = vi.hoisted(() => ({ request: vi.fn(), grants: vi.fn(), availability: vi.fn(), document: vi.fn() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => ({ request: mock.request }) }));
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAgentDelegations: mock.grants,
  cloudAgentBootAvailability: mock.availability,
}));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: mock.document,
  subscribeCloudWorkspaces: () => () => {},
  subscribeCloudWorkspaceRefresh: () => () => {},
}));
import { clearCloudAgentRegistry, invalidateCloudAgentRegistry, modelsForWorkspaceAgent, warmCloudAgentRegistry,
  workspaceAgentsSnapshot } from "../workspace-agent-registry";
import { refreshAgents } from "../agents-cache";

const workspace = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const agents = ["claude", "codex", "cursor"].map(id => ({ id, name: id, version: "1", description: "Cloud provider",
  distribution: {}, installed: true, authenticated: true })) as BridgeRegistryAgent[];
const scope = { generation: 2, bootId: binding.bootId, writerEpoch: binding.writerEpoch,
  fundingOwnerUserId: binding.fundingOwnerUserId, fundingOwnerEpoch: 1 };
const ready = (overrides: Record<string, unknown> = {}) => ({ version: 1, mode: "boot-owner-v1", scope, status: "ready", providers: [
  { provider: "claude", status: "unavailable", code: "cloud_agent_credential_required" },
  { provider: "codex", status: "unavailable", code: "cloud_runtime_upgrade_required" },
  { provider: "cursor", status: "ready", kind: "cursor-api-key", models: ["grok-4.7", "grok-4.6"] },
], ...overrides });
const selectable = () => workspaceAgentsSnapshot(workspace)!.filter(isSelectableAgent).map(agent => agent.id);

beforeEach(async () => {
  vi.resetAllMocks();
  clearCloudAgentRegistry();
  await refreshAgents(async () => agents);
  mock.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents });
  mock.document.mockReturnValue({ agentCredentials: binding });
  // A member's own legacy grants must never decide an activated boot's picker.
  mock.grants.mockResolvedValue([{ id: "88888888-8888-4888-8888-888888888888", kind: "claude-api-key", models: ["claude-sonnet-4-6"],
    runtimeQualified: true, expiresAt: new Date(Date.now() + 60_000).toISOString() }]);
});

describe("activated boot discovery", () => {
  it("shows the funding owner's slots passively, never the actor's own grants", async () => {
    mock.availability.mockResolvedValue(ready());
    await warmCloudAgentRegistry(workspace);
    expect(selectable()).toEqual(["cursor"]);
    const [claude, codex, cursor] = workspaceAgentsSnapshot(workspace)!;
    expect(cursor).toMatchObject({ authenticated: true, cloudModels: ["grok-4.7", "grok-4.6"], runtimeUpgradeRequired: false });
    expect(modelsForWorkspaceAgent(cursor!, null).every(model => ["grok-4.7", "grok-4.6"].includes(model.value))).toBe(true);
    expect(claude).toMatchObject({ authenticated: false, cloudModels: [] });
    expect(codex).toMatchObject({ authenticated: false, runtimeUpgradeRequired: true,
      runtimeUnavailableReason: "This workspace gets the new cloud runtime the next time it wakes" });
    expect(mock.grants).not.toHaveBeenCalled();
  });

  it.each([
    ["owner_changed", "This workspace gets the new cloud runtime the next time it wakes", true],
    ["retired", "This workspace gets the new cloud runtime the next time it wakes", true],
    ["runtime_upgrade_required", "This workspace gets the new cloud runtime the next time it wakes", true],
    ["funding_unavailable", "The workspace owner hasn't shared agent access with you", false],
    ["compute_unavailable", "Agents can't run on this workspace's compute", false],
    ["a-future-status", "Agents can't run on this workspace's compute", false],
  ])("closes every provider while the boot is %s, without falling back", async (status, reason, upgrade) => {
    mock.availability.mockResolvedValue(ready({ status, providers: [] }));
    await warmCloudAgentRegistry(workspace);
    expect(selectable()).toEqual([]);
    for (const agent of workspaceAgentsSnapshot(workspace)!)
      expect(agent).toMatchObject({ authenticated: false, cloudModels: [], runtimeUnavailableReason: reason, runtimeUpgradeRequired: upgrade });
    expect(mock.grants).not.toHaveBeenCalled();
  });

  it.each([["a legacy-mode server reply", { version: 1, mode: "legacy" }], ["a server without passive discovery", null]])(
    "keeps per-actor discovery for %s", async (_name, reply) => {
      mock.availability.mockResolvedValue(reply);
      await warmCloudAgentRegistry(workspace);
      expect(mock.grants).toHaveBeenCalledOnce();
      expect(selectable()).toEqual(["claude"]);
    },
  );

  it("reads legacy grants in parallel and never asks for boot availability without an activated boot", async () => {
    mock.document.mockReturnValue({});
    await warmCloudAgentRegistry(workspace);
    expect(mock.availability).not.toHaveBeenCalled();
    expect(mock.grants).toHaveBeenCalledOnce();
    expect(selectable()).toEqual(["claude"]);
  });

  it("refuses a reply for a different boot than the catalog shows and keeps the confirmed picker", async () => {
    mock.availability.mockResolvedValue(ready());
    await warmCloudAgentRegistry(workspace);
    const confirmed = workspaceAgentsSnapshot(workspace);
    for (const changed of [{ bootId: "99999999-9999-4999-8999-999999999999" }, { fundingOwnerEpoch: 2 }, { generation: 3 }]) {
      mock.availability.mockResolvedValueOnce(ready({ scope: { ...scope, ...changed } }));
      invalidateCloudAgentRegistry(workspace);
      await expect(warmCloudAgentRegistry(workspace)).rejects.toThrow("changed while loading");
      expect(workspaceAgentsSnapshot(workspace)).toBe(confirmed);
    }
    expect(mock.grants).not.toHaveBeenCalled();
  });

  it("leaves Local registries unchanged", async () => {
    mock.availability.mockResolvedValue(ready());
    await warmCloudAgentRegistry(workspace);
    for (const folder of [null, "/local/personal", "/local/organization"]) expect(workspaceAgentsSnapshot(folder)).toBe(agents);
  });
});
